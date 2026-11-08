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
  report_accepted: 'Report accepted',
  notice_sent: 'Notice emailed (10 days started)',
  notice_failed: 'Notice could not be sent',
  notice_bounced: 'Notice bounced (reporter asked for new contact)',
  notice_resent: 'New notice email provided by reporter',
  letter_requested: 'Reporter gave a mailing address (letter to mail)',
  notice_mailed: 'Letter mailed (10 days started)',
  report_published: 'Published',
  subject_linked: 'Linked to the reported party’s account',
  subject_evidence_viewed: 'Reported party opened evidence',
  search_evidence_viewed: 'Evidence opened from a search',
  authorization_viewed: 'Employment authorization opened',
  dispute_opened: 'Disputed by the reported party (report withheld)',
  dispute_response: 'Reporter responded to the dispute',
  dispute_file_viewed: 'Dispute file opened',
  dispute_upheld: 'Dispute resolved: upheld (published)',
  dispute_amended: 'Dispute resolved: amended (published with corrections)',
  dispute_removed: 'Dispute resolved: report removed',
  report_expired_deleted: 'Deleted after 7 years',
  ai_review_requested: 'AI review requested',
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
const N = require('../lib/notices');
const D = require('../lib/disputes');
const AI = require('../lib/ai-review');
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
    await Promise.all(['submitted', 'notice_undeliverable', 'notice_sent', 'published', 'disputed', 'rejected'].map(async st => {
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
    const [{ data: files }, { data: events }, { data: emails }, { count: otherReports }, { data: notices }, { data: disputes }, { data: links }] = await Promise.all([
      supabase.from('fx_report_evidence').select('*').eq('report_id', report.id).order('created_at'),
      supabase.from('fx_events').select('event, actor, detail, created_at').eq('report_id', report.id).order('created_at', { ascending: false }).limit(50),
      supabase.from('fx_subject_emails').select('email').eq('subject_id', report.subject_id),
      supabase.from('fx_reports').select('id', { count: 'exact', head: true }).eq('subject_id', report.subject_id).neq('id', report.id),
      supabase.from('fx_notices').select('*').eq('report_id', report.id).order('created_at', { ascending: false }),
      supabase.from('fx_disputes').select('*, fx_dispute_files(*), fx_accounts(email, first_name, last_name)').eq('report_id', report.id).order('created_at', { ascending: false }),
      supabase.from('fx_subject_links').select('linked_by, fx_accounts(id, email, first_name, last_name, business_legal_name)').eq('subject_id', report.subject_id),
    ]);
    res.render('admin/report', {
      pageTitle: report.subject_name_reported, report, subject: report.fx_subjects, reporter: report.reporter,
      identity: maskedSubject(report.fx_subjects), files: files || [], events: events || [],
      subjectEmails: (emails || []).map(e => e.email), otherReports: otherReports || 0, notices: notices || [], disputes: disputes || [], links: links || [], fmtDay: N.fmtDay, aiReview: await AI.latestReview(report.id), aiEnabled: AI.enabled(),
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

router.post('/reports/:id/accept', async (req, res, next) => {
  try {
    const report = await N.loadFull(req.params.id);
    if (!report) return res.redirect(303, '/admin/reports');
    if (report.status !== 'submitted') return res.redirect(303, backReport(report.id, 'Only reports waiting for review can be accepted.', true));
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 2000) || null : null;
    const { data: claimed } = await supabase.from('fx_reports').update({ review_note: note, reviewed_at: new Date().toISOString(), status: 'notice_sent' })
      .eq('id', report.id).eq('status', 'submitted').select('id').maybeSingle();
    if (!claimed) return res.redirect(303, backReport(report.id, 'This report changed while you were viewing it.', true));
    await logEvent({ accountId: report.reporter_account_id, reportId: report.id, event: 'report_accepted', actor: 'admin', ip: req.ip });
    const result = await N.sendEmailNotice(report, report.notice_email, { ip: req.ip });
    if (!result.ok) return res.redirect(303, backReport(report.id, 'Accepted, but the notice email could not be sent. The reporter was asked for another email address.', true));
    const info = { reportId: report.id, subjectName: report.subject_name_reported, categoryLabel: R.CATEGORIES[report.category].label, publishDate: N.fmtDay(result.publishAt) };
    await sendOrLog({ to: report.reporter.email, tag: 'fx-report-accepted', ...templates.reportAccepted(report.reporter, info) }, report.reporter.id);
    res.redirect(303, backReport(report.id, `Accepted. Notice sent to ${report.notice_email}; publishes ${info.publishDate} unless disputed.`));
  } catch (err) { next(err); }
});

router.post('/reports/:id/ai-review', async (req, res, next) => {
  try {
    if (!AI.enabled()) return res.redirect(303, backReport(req.params.id, 'AI review is off: ANTHROPIC_API_KEY is not set in Render.', true));
    const latest = await AI.latestReview(req.params.id);
    if (latest && latest.status === 'running' && Date.now() - new Date(latest.created_at).getTime() < 5 * 60 * 1000) {
      return res.redirect(303, backReport(req.params.id, 'An AI review is already running. Refresh in a minute.'));
    }
    setImmediate(() => AI.reviewReport(req.params.id, 'admin'));
    await logEvent({ reportId: req.params.id, event: 'ai_review_requested', actor: 'admin', ip: req.ip });
    res.redirect(303, backReport(req.params.id, 'AI review started. Refresh in a minute or two.'));
  } catch (err) { next(err); }
});

// Link the reported party to an account by email (when they signed up with a different email).
router.post('/reports/:id/link', async (req, res, next) => {
  try {
    const report = await N.loadFull(req.params.id);
    if (!report) return res.redirect(303, '/admin/reports');
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const { data: acct } = await supabase.from('fx_accounts').select('id, account_type, status').eq('email', email).eq('status', 'approved').maybeSingle();
    if (!acct) return res.redirect(303, backReport(report.id, 'No approved account uses that email.', true));
    const { error } = await supabase.from('fx_subject_links').upsert({ subject_id: report.subject_id, account_id: acct.id, linked_by: 'admin' }, { onConflict: 'subject_id,account_id', ignoreDuplicates: true });
    if (error) throw new Error(`Link: ${error.message}`);
    await logEvent({ accountId: acct.id, reportId: report.id, event: 'subject_linked', actor: 'admin', ip: req.ip });
    res.redirect(303, backReport(report.id, `Linked to ${email}. They can now see reports about them.`));
  } catch (err) { next(err); }
});

// Disputes queue.
router.get('/disputes', async (req, res, next) => {
  try {
    const open = req.query.status !== 'resolved';
    let q = supabase.from('fx_disputes').select('id, status, due_at, created_at, resolved_at, reporter_responded_at, fx_reports(id, subject_name_reported, category, is_test)')
      .order(open ? 'due_at' : 'resolved_at', { ascending: open }).limit(500);
    q = open ? q.eq('status', 'open') : q.neq('status', 'open');
    const { data, error } = await q;
    if (error) throw new Error(`Disputes: ${error.message}`);
    res.render('admin/disputes', { pageTitle: 'Disputes', disputes: data || [], open, R, fmtDay: N.fmtDay });
  } catch (err) { next(err); }
});

router.get('/disputes/files/:fileId', async (req, res, next) => {
  try {
    const out = await D.signedFile(req.params.fileId, null);
    if (!out) return res.status(404).render('error', { pageTitle: 'Not found', message: 'That file does not exist.' });
    await logEvent({ event: 'dispute_file_viewed', actor: 'admin', detail: { file: out.file.file_name }, ip: req.ip });
    res.redirect(out.url);
  } catch (err) { next(err); }
});

router.post('/reports/:id/resolve', async (req, res, next) => {
  try {
    const outcome = ['upheld', 'amended', 'removed'].includes(req.body.outcome) ? req.body.outcome : null;
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 2000) : '';
    const amended = typeof req.body.amended_description === 'string' ? req.body.amended_description.trim() : '';
    if (!outcome) return res.redirect(303, backReport(req.params.id, 'Choose an outcome.', true));
    if (!note) return res.redirect(303, backReport(req.params.id, 'Add a resolution note. It is shared with both sides.', true));
    if (outcome === 'amended' && (!amended || amended.length > 5000)) return res.redirect(303, backReport(req.params.id, 'Enter the corrected description (up to 5,000 characters).', true));
    const out = await D.resolve({ reportId: req.params.id, outcome, note, amendedDescription: amended, ip: req.ip });
    res.redirect(303, out.error ? backReport(req.params.id, out.error, true) : backReport(req.params.id, `Dispute resolved: ${outcome}. Both sides were emailed.`));
  } catch (err) { next(err); }
});

// Search log.
router.get('/searches', async (req, res, next) => {
  try {
    const S = require('../lib/search');
    const { data, error } = await supabase.from('fx_searches')
      .select('id, subject_type, purpose, criteria, matched_subject_ids, result_report_ids, authorization_id, created_at, fx_accounts(id, business_legal_name)')
      .order('created_at', { ascending: false }).limit(500);
    if (error) throw new Error(`Search log: ${error.message}`);
    res.render('admin/searches', { pageTitle: 'Search log', searches: data || [], R, PURPOSES: S.PURPOSES });
  } catch (err) { next(err); }
});

router.get('/authorizations/:id', async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.redirect('/admin/searches');
    const { data: f } = await supabase.from('fx_authorizations').select('*').eq('id', req.params.id).maybeSingle();
    if (!f) return res.redirect('/admin/searches');
    const { data, error } = await supabase.storage.from('fx-evidence').createSignedUrl(f.storage_path, 120);
    if (error) throw new Error(`Signed URL: ${error.message}`);
    await logEvent({ accountId: f.account_id, event: 'authorization_viewed', actor: 'admin', detail: { file: f.file_name }, ip: req.ip });
    res.redirect(data.signedUrl);
  } catch (err) { next(err); }
});

// Delete a [TEST] report and its files.
router.post('/reports/:id/delete', async (req, res, next) => {
  try {
    const report = await N.loadFull(req.params.id);
    if (!report) return res.redirect(303, '/admin/reports');
    if (!report.is_test) return res.redirect(303, backReport(report.id, 'Only [TEST] reports can be deleted.', true));
    const { data: files } = await supabase.from('fx_report_evidence').select('storage_path').eq('report_id', report.id);
    if (files && files.length) await supabase.storage.from('fx-evidence').remove(files.map(f => f.storage_path));
    const { error } = await supabase.from('fx_reports').delete().eq('id', report.id).eq('is_test', true);
    if (error) throw new Error(`Delete report: ${error.message}`);
    const { count } = await supabase.from('fx_reports').select('id', { count: 'exact', head: true }).eq('subject_id', report.subject_id);
    if (!count) await supabase.from('fx_subjects').delete().eq('id', report.subject_id);
    res.redirect(303, '/admin/reports?status=all');
  } catch (err) { next(err); }
});

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
