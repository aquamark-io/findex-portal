/**
 * Request Access (members) and Check My Record (subjects) sign-up.
 *
 *   GET  /request-access                      company (member) sign-up
 *   GET  /check-my-record                     "Who are you?" chooser
 *   GET  /check-my-record/:who                individual | company | funded-business form
 *   POST /request-access                      validate, store (identity fields encrypted), email applicant + admin
 *   GET  /request-access/received    confirmation
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const supabase = require('../lib/supabase');
const { encrypt, blindIndex } = require('../lib/crypto');
const { sendEmail, templates } = require('../lib/email');
const { logEvent } = require('../lib/events');
const { testNotificationsOn } = require('../lib/notify-admin');
const turnstile = require('../lib/turnstile');
const { validateRequest, ACCOUNT_TYPES, COMPANY_TYPES, WORKER_TYPES, STATES } = require('../lib/validate');
const { INDEMNIFICATION, CFPB_NOTICE_TO_USERS_URL: CFPB_USERS, CFPB_NOTICE_TO_FURNISHERS_URL: CFPB_FURNISHERS } = require('../lib/terms');

const router = express.Router();

const LIVE = ['pending', 'approved'];
// Fields that are never echoed back into the form after a validation error.
const SENSITIVE = ['dob', 'ssn_last4', 'ein'];

const tooMany = (req, res) => res.status(429).render('error', {
  pageTitle: 'Too many requests',
  message: 'Too many requests from this network. Please wait a while and try again.',
});

// All attempts (including ones rejected for typos): generous, so real people aren't locked out.
const attemptLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, handler: tooMany });
// Accepted submissions only (redirects): tight, to stop bulk sign-ups.
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 5, skipFailedRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, handler: tooMany,
});

// mode: 'member' (Request Access, company only) or 'record' (Check My Record, any type).
function renderForm(res, { type, mode = 'member', values = {}, errors = [], status = 200 }) {
  const safe = { ...values };
  for (const k of SENSITIVE) delete safe[k];
  res.status(status).render('request-access', {
    pageTitle: mode === 'member' ? 'Request Access' : 'Check My Record',
    type,
    mode,
    values: safe,
    errors,
    ACCOUNT_TYPES, COMPANY_TYPES, WORKER_TYPES, STATES, INDEMNIFICATION, CFPB_USERS, CFPB_FURNISHERS,
    turnstileSiteKey: turnstile.enabled() ? turnstile.siteKey() : '',
  });
}

// URL slug <-> account type for Check My Record.
const WHO = { individual: 'individual', company: 'company', 'funded-business': 'merchant' };
const SLUG = { individual: 'individual', company: 'company', merchant: 'funded-business' };

router.get('/check-my-record', (req, res) => res.render('check-my-record', { pageTitle: 'Check My Record' }));

router.get('/check-my-record/:who', (req, res) => {
  const type = WHO[req.params.who];
  if (!type) return res.redirect('/check-my-record');
  renderForm(res, { type, mode: 'record' });
});

router.get('/request-access', (req, res) => {
  // Old links (?type=individual / merchant) go to the Check My Record forms.
  if (req.query.type && req.query.type !== 'company' && SLUG[req.query.type]) {
    return res.redirect(301, `/check-my-record/${SLUG[req.query.type]}`);
  }
  renderForm(res, { type: 'company', mode: 'member' });
});

router.get('/request-access/received', (req, res) => res.render('received', { pageTitle: 'Request received' }));

router.post('/request-access', attemptLimiter, submitLimiter, async (req, res, next) => {
  const body = req.body || {};
  const type = Object.prototype.hasOwnProperty.call(ACCOUNT_TYPES, body.account_type) ? body.account_type : 'company';
  // Individuals and funded businesses always sign up through Check My Record.
  const mode = type === 'company' && body.mode !== 'record' ? 'member' : 'record';

  try {
    // Honeypot: real people never see or fill this field. Pretend it worked.
    if (body.company_fax) return res.redirect(303, '/request-access/received');

    if (!(await turnstile.verify(body['cf-turnstile-response'], req.ip))) {
      return renderForm(res, { type, mode, values: body, errors: ['Please complete the verification check and try again.'], status: 422 });
    }

    const { errors, data } = validateRequest(body, { mode });
    if (errors.length) return renderForm(res, { type, mode, values: body, errors, status: 422 });

    // Same email already pending/approved: show the normal confirmation so the form
    // can't be used to discover who has an account.
    const { data: existing, error: findErr } = await supabase.from('fx_accounts')
      .select('*').eq('email', data.email).in('status', LIVE).limit(1);
    if (findErr) throw new Error(`Duplicate check: ${findErr.message}`);
    if (existing && existing.length) {
      await handleDuplicate(existing[0], req.ip);
      return res.redirect(303, '/request-access/received');
    }

    if (data.account_type === 'company') {
      const { data: sameDomain, error: domErr } = await supabase.from('fx_accounts')
        .select('id').eq('account_type', 'company').eq('email_domain', data.email_domain).in('status', LIVE).limit(1);
      if (domErr) throw new Error(`Domain check: ${domErr.message}`);
      if (sameDomain && sameDomain.length) return renderForm(res, { type, mode, values: body, errors: [companyExistsMessage], status: 409 });
    }

    const row = toRow(data);
    const { data: account, error: insErr } = await supabase.from('fx_accounts').insert(row).select('*').single();
    if (insErr) {
      if (insErr.code === '23505' && /email_live/.test(insErr.message)) {
        const { data: dup } = await supabase.from('fx_accounts').select('*').eq('email', data.email).in('status', LIVE).limit(1);
        if (dup && dup.length) await handleDuplicate(dup[0], req.ip);
        return res.redirect(303, '/request-access/received');
      }
      if (insErr.code === '23505' && /company_domain/.test(insErr.message)) {
        return renderForm(res, { type, mode, values: body, errors: [companyExistsMessage], status: 409 });
      }
      throw new Error(`Insert: ${insErr.message}`);
    }

    await logEvent({ accountId: account.id, event: 'requested', actor: 'applicant', detail: { account_type: account.account_type, is_test: account.is_test, terms_version: account.terms_version }, ip: req.ip });
    await notify(account);

    return res.redirect(303, '/request-access/received');
  } catch (err) {
    return next(err);
  }
});

const companyExistsMessage = 'Your company already has a FinDex account or a pending request. One account is allowed per company, so please contact the person at your company who manages it.';

// Same email already has a pending/approved account. The screen shows the normal confirmation (so the form
// can't be used to look up accounts); the email tells the inbox owner what's going on. At most one such email
// per account per hour.
async function handleDuplicate(account, ip) {
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabase.from('fx_events').select('id', { count: 'exact', head: true })
      .eq('account_id', account.id).eq('event', 'duplicate_request').gte('created_at', since);
    const notify = (count || 0) === 0;
    await logEvent({ accountId: account.id, event: 'duplicate_request', actor: 'applicant', detail: { emailed: notify }, ip });
    if (!notify) return;
    const approved = account.status === 'approved';
    const tpl = approved ? templates.alreadyHaveAccount(account) : templates.requestAlreadyPending(account);
    await sendEmail({ to: account.email, tag: approved ? 'fx-duplicate-approved' : 'fx-duplicate-pending', ...tpl });
  } catch (err) {
    console.error(`Duplicate sign-up handling for account ${account.id} failed:`, err.message);
  }
}

function toRow(d) {
  const row = {
    account_type: d.account_type,
    email: d.email,
    first_name: d.first_name,
    last_name: d.last_name,
    phone: d.phone,
    job_title: d.job_title || null,
    business_legal_name: d.business_legal_name || null,
    business_dba: d.business_dba || null,
    company_type: d.company_type || null,
    website: d.website || null,
    email_domain: d.email_domain || null,
    state_of_registration: d.state_of_registration || null,
    current_company: d.current_company || null,
    worker_type: d.worker_type || null,
    identity_method: d.identity_method || null,
    is_test: d.is_test,
    terms_version: d.terms_version || null,
    terms_accepted_at: d.terms_version ? new Date().toISOString() : null,
  };
  if (d.identity_method === 'dob_ssn4') {
    row.dob_enc = encrypt(d.dob);
    row.ssn_last4_enc = encrypt(d.ssn_last4);
    row.identity_hash = blindIndex(`person:${d.dob}:${d.ssn_last4}`);
  } else if (d.identity_method === 'ein') {
    row.ein_enc = encrypt(d.ein);
    row.identity_hash = blindIndex(`ein:${d.ein}`);
  }
  return row;
}

// Email the applicant, and the admin unless it's a [TEST] request. Failures are logged, not fatal:
// the request is already saved and visible in /admin.
async function notify(account) {
  const jobs = [{ to: account.email, tag: 'fx-under-review', ...templates.underReview(account) }];
  if ((!account.is_test || testNotificationsOn()) && process.env.ONBOARDING_NOTIFY_EMAIL) {
    jobs.push({ to: process.env.ONBOARDING_NOTIFY_EMAIL, tag: 'fx-admin-new-request', ...templates.adminNewRequest(account) });
  }
  const results = await Promise.allSettled(jobs.map(j => sendEmail(j)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`Email "${jobs[i].tag}" for account ${account.id} failed:`, r.reason.message);
  });
}

module.exports = router;
