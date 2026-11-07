/**
 * Admin (/admin). One user, ADMIN_PASSWORD.
 *
 *   /admin?status=pending|approved|denied|all   request list (pending first by default)
 *   /admin/accounts/:id                          details (identity masked) + history
 *   POST /admin/accounts/:id/approve             activate + "you're approved" email
 *   POST /admin/accounts/:id/deny                deny (or revoke) + polite denial email
 *   POST /admin/accounts/:id/delete              delete a [TEST] request only
 */
const express = require('express');
const supabase = require('../lib/supabase');
const admin = require('../middleware/admin');
const { decrypt } = require('../lib/crypto');
const { sendEmail, templates } = require('../lib/email');
const { logEvent } = require('../lib/events');
const { ACCOUNT_TYPES, COMPANY_TYPES, WORKER_TYPES, STATES } = require('../lib/validate');

const router = express.Router();
const STATUSES = ['pending', 'approved', 'denied'];

// Plain-English labels for the History list.
const EVENT_LABELS = {
  requested: 'Request submitted',
  full_access_accepted: 'Accepted the terms (full access)',
  report_submitted: 'Report submitted',
  report_rejected: 'Report rejected (reporter emailed the reason)',
  evidence_viewed: 'Evidence file opened',
  duplicate_request: 'Submitted again with the same email (no new request created)',
  approved: 'Approved',
  denied: 'Denied',
  revoked: 'Access revoked',
  code_sent: 'Sign-in code sent',
  code_rate_limited: 'Sign-in code not sent (too many requests)',
  login: 'Signed in',
  login_failed: 'Wrong sign-in code entered',
  logout: 'Signed out',
};
function eventLabel(e) {
  if (e.event === 'signin_notice') return e.detail && e.detail.kind === 'pending' ? 'Sign-in attempt (still pending, told by email)' : 'Sign-in attempt (no account, told by email)';
  return EVENT_LABELS[e.event] || e.event.replace(/_/g, ' ');
}
const ACTORS = { applicant: 'applicant', account: 'user', admin: 'you', system: 'system' };

const fmt = d => d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) : '';

// ---------- login ----------

router.get('/login', (req, res) => res.render('admin/login', { pageTitle: 'Admin', error: null, adminNav: false }));

router.post('/login', (req, res) => {
  const ip = req.ip;
  const fail = (status, error) => res.status(status).render('admin/login', { pageTitle: 'Admin', error, adminNav: false });
  if (admin.tooManyFailures(ip)) return fail(429, 'Too many attempts. Try again in 15 minutes.');
  if (!process.env.ADMIN_PASSWORD) return fail(500, 'ADMIN_PASSWORD is not set on the server.');
  if (!admin.passwordOk(req.body.password)) {
    admin.recordFailure(ip);
    return fail(401, 'Incorrect password.');
  }
  admin.setSession(res);
  res.redirect(303, '/admin');
});

router.post('/logout', (req, res) => {
  admin.clearSession(res);
  res.redirect(303, '/admin/login');
});

router.use(admin.requireAdmin);
router.use((req, res, next) => {
  Object.assign(res.locals, { fmt, fmtPhone, eventLabel, ACTORS, adminNav: true, ACCOUNT_TYPES, COMPANY_TYPES, WORKER_TYPES, STATES });
  next();
});

// ---------- helpers ----------

const fmtPhone = p => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
};

const displayName = a => a.business_legal_name || `${a.first_name} ${a.last_name}`;

// Masked identity for display. Never returns a full DOB, SSN, or EIN.
function maskedIdentity(a) {
  const out = [];
  try {
    if (a.identity_method === 'dob_ssn4') {
      const label = a.account_type === 'merchant' ? "Owner's " : '';
      out.push([`${label}DOB`, a.dob_enc ? 'DOB on file' : 'Missing']);
      const last4 = decrypt(a.ssn_last4_enc);
      out.push([`${label}SSN`, last4 ? `***-**-${last4}` : 'Missing']);
    } else if (a.identity_method === 'ein') {
      const ein = decrypt(a.ein_enc);
      out.push(['EIN', ein ? `**-***${ein.slice(-4)}` : 'Missing']);
    }
  } catch (err) {
    console.error(`Identity decrypt failed for account ${a.id}`);
    out.push(['Identity', 'On file (could not decrypt: check FIELD_ENCRYPTION_KEY)']);
  }
  return out;
}

async function loadAccount(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data, error } = await supabase.from('fx_accounts').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Load account: ${error.message}`);
  return data;
}

const back = (id, msg, err) => `/admin/accounts/${id}?${new URLSearchParams(err ? { err: msg } : { msg })}`;

async function sendOrLog(job, accountId) {
  try {
    await sendEmail(job);
    return true;
  } catch (err) {
    console.error(`Email "${job.tag}" for account ${accountId} failed:`, err.message);
    return false;
  }
}

// ---------- list ----------

router.get('/', async (req, res, next) => {
  try {
    const status = STATUSES.includes(req.query.status) || req.query.status === 'all' ? req.query.status : 'pending';
    let q = supabase.from('fx_accounts')
      .select('id, account_type, status, first_name, last_name, email, business_legal_name, company_type, is_test, created_at, reviewed_at')
      .order('created_at', { ascending: false }).limit(500);
    if (status !== 'all') q = q.eq('status', status);
    const { data: accounts, error } = await q;
    if (error) throw new Error(`List accounts: ${error.message}`);

    const counts = {};
    await Promise.all(STATUSES.map(async s => {
      const { count } = await supabase.from('fx_accounts').select('id', { count: 'exact', head: true }).eq('status', s);
      counts[s] = count || 0;
    }));

    res.render('admin/list', { pageTitle: 'Requests', accounts: accounts || [], status, counts, displayName });
  } catch (err) { next(err); }
});

// ---------- detail ----------

router.get('/accounts/:id', async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.status(404).render('error', { pageTitle: 'Not found', message: 'That request does not exist.' });
    const { data: events } = await supabase.from('fx_events')
      .select('event, actor, detail, created_at').eq('account_id', account.id).order('created_at', { ascending: false }).limit(50);
    res.render('admin/detail', {
      pageTitle: displayName(account),
      account,
      identity: maskedIdentity(account),
      events: events || [],
      displayName,
      msg: typeof req.query.msg === 'string' ? req.query.msg : null,
      err: typeof req.query.err === 'string' ? req.query.err : null,
    });
  } catch (err) { next(err); }
});

// ---------- decisions ----------

const note = body => (typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '') || null;

router.post('/accounts/:id/approve', async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.redirect(303, '/admin');
    if (account.status === 'approved') return res.redirect(303, back(account.id, 'Already approved.'));
    const from = account.status;

    const { data: updated, error } = await supabase.from('fx_accounts')
      .update({ status: 'approved', review_note: note(req.body), reviewed_at: new Date().toISOString() })
      .eq('id', account.id).eq('status', from).select('*').maybeSingle();
    if (error) {
      if (error.code === '23505') {
        return res.redirect(303, back(account.id, 'Another live account already uses this email or company domain. Deny or remove that one first.', true));
      }
      throw new Error(`Approve: ${error.message}`);
    }
    if (!updated) return res.redirect(303, back(account.id, 'This request changed while you were viewing it. Please review it again.', true));

    const sent = await sendOrLog({ to: updated.email, tag: 'fx-approved', ...templates.approved(updated) }, updated.id);
    await logEvent({ accountId: updated.id, event: 'approved', actor: 'admin', detail: { from, email_sent: sent, has_note: Boolean(updated.review_note) }, ip: req.ip });
    res.redirect(303, back(updated.id, sent ? 'Approved. Approval email sent.' : 'Approved, but the approval email failed to send. Check the Postmark settings.', !sent));
  } catch (err) { next(err); }
});

router.post('/accounts/:id/deny', async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.redirect(303, '/admin');
    if (account.status === 'denied') return res.redirect(303, back(account.id, 'Already denied.'));
    const from = account.status;

    const { data: updated, error } = await supabase.from('fx_accounts')
      .update({ status: 'denied', review_note: note(req.body), reviewed_at: new Date().toISOString() })
      .eq('id', account.id).eq('status', from).select('*').maybeSingle();
    if (error) throw new Error(`Deny: ${error.message}`);
    if (!updated) return res.redirect(303, back(account.id, 'This request changed while you were viewing it. Please review it again.', true));

    // Revoke any outstanding sign-in codes.
    await supabase.from('fx_login_codes').delete().eq('account_id', updated.id);

    const sent = await sendOrLog({ to: updated.email, tag: 'fx-denied', ...templates.denied(updated) }, updated.id);
    await logEvent({ accountId: updated.id, event: from === 'approved' ? 'revoked' : 'denied', actor: 'admin', detail: { from, email_sent: sent, has_note: Boolean(updated.review_note) }, ip: req.ip });
    res.redirect(303, back(updated.id, sent ? 'Denied. Denial email sent.' : 'Denied, but the denial email failed to send. Check the Postmark settings.', !sent));
  } catch (err) { next(err); }
});

router.post('/accounts/:id/delete', async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id);
    if (!account) return res.redirect(303, '/admin');
    if (!account.is_test) return res.redirect(303, back(account.id, 'Only [TEST] requests can be deleted.', true));
    const { error } = await supabase.from('fx_accounts').delete().eq('id', account.id).eq('is_test', true);
    if (error) throw new Error(`Delete: ${error.message}`);
    res.redirect(303, `/admin?${new URLSearchParams({ status: 'all' })}`);
  } catch (err) { next(err); }
});

// ---------- reports (phase two) ----------

const R = require('../lib/reports');
const { STATUS_LABELS } = require('./reports');
const REPORT_STATUSES = ['submitted', 'rejected', 'notice_sent', 'notice_undeliverable', 'published', 'disputed', 'removed', 'expired'];
const dateOnly = d => d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';

router.use('/reports', (req, res, next) => { Object.assign(res.locals, { R, STATUS_LABELS, dateOnly }); next(); });

router.get('/reports', async (req, res, next) => {
  try {
    const status = REPORT_STATUSES.includes(req.query.status) || req.query.status === 'all' ? req.query.status : 'submitted';
    let q = supabase.from('fx_reports')
      .select('id, category, incident_date, status, is_test, created_at, subject_name_reported, fx_subjects(subject_type), reporter:fx_accounts!fx_reports_reporter_account_id_fkey(business_legal_name, company_type)')
      .order('created_at', { ascending: false }).limit(500);
    if (status !== 'all') q = q.eq('status', status);
    const { data: reports, error } = await q;
    if (error) throw new Error(`List reports: ${error.message}`);
    const counts = {};
    await Promise.all(['submitted', 'notice_sent', 'published', 'disputed', 'rejected'].map(async st => {
      const { count } = await supabase.from('fx_reports').select('id', { count: 'exact', head: true }).eq('status', st);
      counts[st] = count || 0;
    }));
    res.render('admin/reports', { pageTitle: 'Reports', reports: reports || [], status, counts });
  } catch (err) { next(err); }
});

function maskedSubject(s) {
  const out = [];
  try {
    if (s.dob_enc) out.push(['DOB', 'DOB on file']);
    if (s.ssn_last4_enc) out.push(['SSN', `***-**-${decrypt(s.ssn_last4_enc)}`]);
    if (s.ein_enc) { const e = decrypt(s.ein_enc); out.push(['EIN', `**-***${e.slice(-4)}`]); }
  } catch (err) {
    console.error(`Subject decrypt failed for ${s.id}`);
    out.push(['Identity', 'On file (could not decrypt)']);
  }
  return out;
}

async function loadReport(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data, error } = await supabase.from('fx_reports').select('*, fx_subjects(*), reporter:fx_accounts!fx_reports_reporter_account_id_fkey(*)').eq('id', id).maybeSingle();
  if (error) throw new Error(`Load report: ${error.message}`);
  return data;
}

router.get('/reports/:id', async (req, res, next) => {
  try {
    const report = await loadReport(req.params.id);
    if (!report) return res.status(404).render('error', { pageTitle: 'Not found', message: 'That report does not exist.' });
    const [{ data: files }, { data: events }, { data: emails }, { count: otherReports }] = await Promise.all([
      supabase.from('fx_report_evidence').select('*').eq('report_id', report.id).order('created_at'),
      supabase.from('fx_events').select('event, actor, detail, created_at').eq('report_id', report.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('fx_subject_emails').select('email').eq('subject_id', report.subject_id),
      supabase.from('fx_reports').select('id', { count: 'exact', head: true }).eq('subject_id', report.subject_id).neq('id', report.id),
    ]);
    res.render('admin/report', {
      pageTitle: report.subject_name_reported, report, subject: report.fx_subjects, reporter: report.reporter,
      identity: maskedSubject(report.fx_subjects), files: files || [], events: events || [],
      subjectEmails: (emails || []).map(e => e.email), otherReports: otherReports || 0,
      msg: typeof req.query.msg === 'string' ? req.query.msg : null, err: typeof req.query.err === 'string' ? req.query.err : null,
    });
  } catch (err) { next(err); }
});

// Evidence files open through a short-lived signed link; every open is logged.
router.get('/reports/:id/files/:fileId', async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.fileId)) return res.redirect(`/admin/reports/${req.params.id}`);
    const { data: f } = await supabase.from('fx_report_evidence').select('*').eq('id', req.params.fileId).eq('report_id', req.params.id).maybeSingle();
    if (!f) return res.status(404).render('error', { pageTitle: 'Not found', message: 'That file does not exist.' });
    const { data, error } = await supabase.storage.from('fx-evidence').createSignedUrl(f.storage_path, 120);
    if (error) throw new Error(`Signed URL: ${error.message}`);
    await logEvent({ reportId: f.report_id, event: 'evidence_viewed', actor: 'admin', detail: { file: f.file_name }, ip: req.ip });
    res.redirect(data.signedUrl);
  } catch (err) { next(err); }
});

const backReport = (id, msg, err) => `/admin/reports/${id}?${new URLSearchParams(err ? { err: msg } : { msg })}`;

router.post('/reports/:id/reject', async (req, res, next) => {
  try {
    const report = await loadReport(req.params.id);
    if (!report) return res.redirect(303, '/admin/reports');
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 2000) : '';
    if (!reason) return res.redirect(303, backReport(report.id, 'A reason is required to reject a report. It is shared with the reporter.', true));
    if (report.status !== 'submitted') return res.redirect(303, backReport(report.id, 'Only reports waiting for review can be rejected.', true));
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 2000) || null : null;
    const { data: updated, error } = await supabase.from('fx_reports')
      .update({ status: 'rejected', rejection_reason: reason, review_note: note, reviewed_at: new Date().toISOString() })
      .eq('id', report.id).eq('status', 'submitted').select('id').maybeSingle();
    if (error) throw new Error(`Reject report: ${error.message}`);
    if (!updated) return res.redirect(303, backReport(report.id, 'This report changed while you were viewing it.', true));
    const info = { reportId: report.id, categoryLabel: R.CATEGORIES[report.category].label, subjectName: report.subject_name_reported };
    const sent = await sendOrLog({ to: report.reporter.email, tag: 'fx-report-rejected', ...templates.reportRejected(report.reporter, info, reason) }, report.reporter.id);
    await logEvent({ accountId: report.reporter_account_id, reportId: report.id, event: 'report_rejected', actor: 'admin', detail: { email_sent: sent }, ip: req.ip });
    res.redirect(303, backReport(report.id, sent ? 'Rejected. The reporter was emailed the reason.' : 'Rejected, but the email to the reporter failed.', !sent));
  } catch (err) { next(err); }
});

module.exports = router;
