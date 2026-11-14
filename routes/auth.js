/**
 * Passwordless sign-in with emailed one-time codes.
 *
 *   GET/POST /login          enter email. Same response whether or not the account exists or is approved.
 *   GET/POST /login/verify   enter the 6-digit code
 *   POST     /login/resend   send a fresh code
 *   POST     /logout
 *
 * Codes: 6 digits, 10-minute expiry, single use, stored as HMAC, max 5 attempts, a new code
 * cancels older ones, at most 3 codes per account per 15 minutes, plus per-IP rate limits.
 *
 * The screen never says whether an account exists. The email does, so only the inbox owner learns it:
 * approved -> sign-in code; pending -> "still under review"; denied or none -> "no account found".
 * Those last two are sent at most once per email address per hour.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const supabase = require('../lib/supabase');
const { codeHash, blindIndex } = require('../lib/crypto');
const { sendEmail, templates } = require('../lib/email');
const { logEvent } = require('../lib/events');
const session = require('../lib/session');
const { notifyAdminActivity } = require('../lib/notify-admin');

const router = express.Router();

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_WINDOW = 3;
const CODE_WINDOW_MS = 15 * 60 * 1000;

const limited = message => (req, res) => res.status(429).render('login', { pageTitle: 'Sign In', error: message, email: '' });
const requestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: limited('Too many sign-in requests from this network. Please wait 15 minutes and try again.') });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 25, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).render('verify', { pageTitle: 'Enter code', error: 'Too many attempts from this network. Please wait 15 minutes and try again.', email: '' }) });

const normEmail = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const validEmail = v => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v);

// Delete codes that expired over a day ago, at most once an hour. Replaces a cron job.
let lastCleanup = 0;
function cleanupCodes() {
  if (Date.now() - lastCleanup < 60 * 60 * 1000) return;
  lastCleanup = Date.now();
  supabase.from('fx_login_codes').delete().lt('expires_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .then(({ error }) => { if (error) console.error('Code cleanup failed:', error.message); });
}

async function approvedAccount(email) {
  const { data, error } = await supabase.from('fx_accounts').select('*').eq('email', email).eq('status', 'approved').maybeSingle();
  if (error) throw new Error(`Account lookup: ${error.message}`);
  return data;
}

async function pendingAccount(email) {
  const { data, error } = await supabase.from('fx_accounts').select('*').eq('email', email).eq('status', 'pending').maybeSingle();
  if (error) throw new Error(`Account lookup: ${error.message}`);
  return data;
}

// Pending / no-account notices: at most one per email address per hour (tracked by a keyed hash, not the address).
const NOTICE_WINDOW_MS = 60 * 60 * 1000;
async function sendNotice({ email, account, kind, ip }) {
  const emailHash = blindIndex(`signin-notice:${email}`);
  const since = new Date(Date.now() - NOTICE_WINDOW_MS).toISOString();
  const { count, error } = await supabase.from('fx_events')
    .select('id', { count: 'exact', head: true }).eq('event', 'signin_notice').eq('detail->>email_hash', emailHash).gte('created_at', since);
  if (error) throw new Error(`Notice count: ${error.message}`);
  if ((count || 0) >= 1) return;
  const tpl = kind === 'pending' ? templates.signInPending(account) : templates.signInNoAccount();
  await sendEmail({ to: email, tag: kind === 'pending' ? 'fx-sign-in-pending' : 'fx-sign-in-no-account', ...tpl });
  await logEvent({ accountId: account ? account.id : null, event: 'signin_notice', actor: 'system', detail: { kind, email_hash: emailHash }, ip });
  await notifyAdminActivity(kind, { email, account });
}

// Runs after the response is sent, so timing doesn't reveal whether the account exists.
async function issueCode(email, ip) {
  try {
    cleanupCodes();
    const account = await approvedAccount(email);
    if (!account) {
      const pending = await pendingAccount(email);
      await sendNotice({ email, account: pending, kind: pending ? 'pending' : 'none', ip });
      return;
    }

    const since = new Date(Date.now() - CODE_WINDOW_MS).toISOString();
    const { count, error: countErr } = await supabase.from('fx_login_codes')
      .select('id', { count: 'exact', head: true }).eq('account_id', account.id).gte('created_at', since);
    if (countErr) throw new Error(`Code count: ${countErr.message}`);
    if ((count || 0) >= MAX_CODES_PER_WINDOW) {
      await logEvent({ accountId: account.id, event: 'code_rate_limited', actor: 'system', ip });
      return;
    }

    // A new code cancels any earlier unused ones.
    await supabase.from('fx_login_codes').update({ used_at: new Date().toISOString() }).eq('account_id', account.id).is('used_at', null);

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const { error: insErr } = await supabase.from('fx_login_codes').insert({
      account_id: account.id,
      code_hash: codeHash(account.id, code),
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      ip,
    });
    if (insErr) throw new Error(`Code insert: ${insErr.message}`);

    await sendEmail({ to: account.email, tag: 'fx-sign-in-code', ...templates.signInCode(account, code) });
    await logEvent({ accountId: account.id, event: 'code_sent', actor: 'system', ip });
  } catch (err) {
    console.error('Issuing sign-in code failed:', err.message);
  }
}

// ---------- routes ----------

router.get('/login', (req, res) => {
  if (session.readSession(req)) return res.redirect('/dashboard');
  res.render('login', { pageTitle: 'Sign In', error: null, email: '' });
});

router.post('/login', requestLimiter, (req, res) => {
  const email = normEmail(req.body.email);
  if (!validEmail(email)) return res.status(422).render('login', { pageTitle: 'Sign In', error: 'Please enter a valid email address.', email });
  session.setLoginEmail(res, email);
  res.redirect(303, '/login/verify');
  setImmediate(() => issueCode(email, req.ip));
});

router.get('/login/verify', (req, res) => {
  const email = session.readLoginEmail(req);
  if (!email) return res.redirect('/login');
  res.render('verify', { pageTitle: 'Enter code', error: null, email, resent: req.query.resent === '1' });
});

router.post('/login/resend', requestLimiter, (req, res) => {
  const email = session.readLoginEmail(req);
  if (!email) return res.redirect(303, '/login');
  session.setLoginEmail(res, email);
  res.redirect(303, '/login/verify?resent=1');
  setImmediate(() => issueCode(email, req.ip));
});

router.post('/login/verify', verifyLimiter, async (req, res, next) => {
  const email = session.readLoginEmail(req);
  if (!email) return res.redirect(303, '/login');
  const code = typeof req.body.code === 'string' ? req.body.code.replace(/\D/g, '') : '';
  const fail = (message, status = 401) => res.status(status).render('verify', { pageTitle: 'Enter code', error: message, email, resent: false });
  const GENERIC = 'That code is incorrect or has expired. Check the code, or request a new one.';

  try {
    if (code.length !== 6) return fail('Please enter the 6-digit code from your email.', 422);

    const account = await approvedAccount(email);
    if (!account) return fail(GENERIC);

    const { data: row, error } = await supabase.from('fx_login_codes')
      .select('id, code_hash, attempts, expires_at')
      .eq('account_id', account.id).is('used_at', null).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`Code lookup: ${error.message}`);
    if (!row) return fail(GENERIC);
    if (row.attempts >= MAX_ATTEMPTS) return fail('Too many incorrect attempts. Please request a new code.', 429);

    const given = Buffer.from(codeHash(account.id, code), 'hex');
    const want = Buffer.from(row.code_hash, 'hex');
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      const attempts = row.attempts + 1;
      await supabase.from('fx_login_codes').update({ attempts, ...(attempts >= MAX_ATTEMPTS ? { used_at: new Date().toISOString() } : {}) })
        .eq('id', row.id).eq('attempts', row.attempts);
      await logEvent({ accountId: account.id, event: 'login_failed', actor: 'account', detail: { attempts }, ip: req.ip });
      return fail(attempts >= MAX_ATTEMPTS ? 'Too many incorrect attempts. Please request a new code.' : GENERIC);
    }

    // Mark used; the used_at filter makes this single-use even under concurrent submits.
    const { data: used, error: useErr } = await supabase.from('fx_login_codes')
      .update({ used_at: new Date().toISOString() }).eq('id', row.id).is('used_at', null).select('id').maybeSingle();
    if (useErr) throw new Error(`Code use: ${useErr.message}`);
    if (!used) return fail(GENERIC);

    await supabase.from('fx_accounts').update({ last_login_at: new Date().toISOString() }).eq('id', account.id);
    await logEvent({ accountId: account.id, event: 'login', actor: 'account', ip: req.ip });
    session.clearLoginEmail(res);
    session.setSession(res, account);
    return res.redirect(303, '/dashboard');
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', async (req, res) => {
  const s = session.readSession(req);
  session.clearSession(res);
  if (s) await logEvent({ accountId: s.sub, event: 'logout', actor: 'account', ip: req.ip });
  res.redirect(303, '/login');
});

module.exports = router;
