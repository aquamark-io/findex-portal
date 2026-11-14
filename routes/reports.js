/**
 * Member reporting (companies with full access).
 *
 *   GET  /reports                       your reports
 *   GET  /reports/new                   who are you reporting? (individual / partner / funded business)
 *   GET  /reports/new/:who              report form
 *   POST /reports/new/:who              validate, store evidence in fx-evidence, create the report
 *   GET  /reports/:id                   one of your reports
 */
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const supabase = require('../lib/supabase');
const { requireAccount } = require('../middleware/auth');
const { encrypt, blindIndex } = require('../lib/crypto');
const { logEvent } = require('../lib/events');
const { sendEmail, templates, disputeEmails } = require('../lib/email');
const { testNotificationsOn } = require('../lib/notify-admin');
const R = require('../lib/reports');
const { validateReport } = require('../lib/report-validate');
const N = require('../lib/notices');
const AI = require('../lib/ai-review');
const D = require('../lib/disputes');
const respUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: R.MAX_FILE_BYTES, files: D.MAX_DISPUTE_FILES, fields: 10, fieldSize: 20000 } }).array('files', D.MAX_DISPUTE_FILES);

const router = express.Router();
const BUCKET = 'fx-evidence';

const STATUS_LABELS = {
  submitted: 'Under review', rejected: 'Not accepted', notice_sent: 'Notice sent', notice_undeliverable: 'Notice undeliverable',
  published: 'Published', disputed: 'Disputed', removed: 'Removed', expired: 'Expired',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: R.MAX_FILE_BYTES, files: R.MAX_FILES + 1, fields: 40, fieldSize: 20000 },
}).fields([{ name: 'evidence', maxCount: R.MAX_FILES }, { name: 'default_notice', maxCount: 1 }]);

// Only companies with full access (accepted terms) can report.
function requireReporter(req, res, next) {
  const a = req.account;
  if (a.account_type === 'company' && a.terms_version) return next();
  return res.redirect('/dashboard');
}

// Plain dates (incident date) are shown as-is; timestamps (submitted) in Pacific time, matching admin.
const fmtDate = d => {
  if (!d) return '';
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  return String(d).length <= 10
    ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' })
    : new Date(d).toLocaleDateString('en-US', { ...opts, timeZone: 'America/Los_Angeles' });
};

router.use('/reports', requireAccount, requireReporter, (req, res, next) => {
  Object.assign(res.locals, { R, STATUS_LABELS, fmtDate });
  next();
});

// ---------- list ----------

router.get('/reports', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('fx_reports')
      .select('id, category, incident_date, status, created_at, subject_name_reported, fx_subjects(subject_type)')
      .eq('reporter_account_id', req.account.id).order('created_at', { ascending: false }).limit(500);
    if (error) throw new Error(`List reports: ${error.message}`);
    res.render('reports/list', { pageTitle: 'Your reports', reports: data || [] });
  } catch (err) { next(err); }
});

// ---------- new ----------

router.get('/reports/new', (req, res) => res.render('reports/choose', { pageTitle: 'Submit a report' }));

function renderForm(res, { who, subjectType, values = {}, errors = [], status = 200 }) {
  const safe = { ...values };
  delete safe.subject_dob; delete safe.subject_ssn_last4; delete safe.subject_ein;
  res.status(status).render('reports/form', {
    pageTitle: 'Submit a report', who, subjectType, values: safe, errors,
    categories: R.categoriesFor(subjectType, res.locals.account),
    maxDate: new Date().toISOString().slice(0, 10),
    contactEmail: process.env.CONTACT_EMAIL || process.env.ONBOARDING_NOTIFY_EMAIL || '',
  });
}

router.get('/reports/new/:who', (req, res) => {
  const subjectType = R.SUBJECT_SLUG[req.params.who];
  if (!subjectType) return res.redirect('/reports/new');
  renderForm(res, { who: req.params.who, subjectType });
});

router.post('/reports/new/:who', (req, res, next) => {
  const subjectType = R.SUBJECT_SLUG[req.params.who];
  if (!subjectType) return res.redirect(303, '/reports/new');
  upload(req, res, async uploadErr => {
    const who = req.params.who;
    if (uploadErr) {
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 25 MB or smaller.'
        : uploadErr.code === 'LIMIT_FILE_COUNT' || uploadErr.code === 'LIMIT_UNEXPECTED_FILE' ? `Up to ${R.MAX_FILES} evidence files and one default notice per report.`
        : 'The upload could not be read. Please try again.';
      return renderForm(res, { who, subjectType, values: req.body || {}, errors: [msg], status: 422 });
    }
    try {
      const account = req.account;
      const { errors, subject, report, uploads } = validateReport(req.body || {}, req.files || {}, { subjectType, account });
      if (errors.length) return renderForm(res, { who, subjectType, values: req.body, errors, status: 422 });

      const subjectRow = await findOrCreateSubject(subject);
      await supabase.from('fx_subject_emails').upsert({ subject_id: subjectRow.id, email: report.notice_email }, { onConflict: 'subject_id,email', ignoreDuplicates: true });

      // Upload files first (under a fresh report id); only then create the report and evidence rows.
      const reportId = crypto.randomUUID();
      const stored = [];
      try {
        for (const u of uploads) {
          const fileId = crypto.randomUUID();
          const path = `${reportId}/${fileId}/${R.safeName(u.file.originalname)}`;
          const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, u.file.buffer, { contentType: u.mime, upsert: false });
          if (upErr) throw new Error(`Upload ${u.file.originalname}: ${upErr.message}`);
          stored.push({ id: fileId, report_id: reportId, kind: u.kind, storage_path: path, file_name: u.file.originalname.slice(0, 200), mime_type: u.mime, size_bytes: u.file.size, sha256: R.sha256(u.file.buffer) });
        }
        const isTest = /^\[test\]/i.test(subject.name || '') || account.is_test === true;
        const { error: insErr } = await supabase.from('fx_reports').insert({
          id: reportId, reporter_account_id: account.id, subject_id: subjectRow.id,
          category: report.category, incident_date: report.incident_date, description: report.description,
          notice_email: report.notice_email, subject_name_reported: report.subject_name_reported,
          certified_at: new Date().toISOString(), terms_version: account.terms_version, is_test: isTest,
        });
        if (insErr) throw new Error(`Insert report: ${insErr.message}`);
        const { error: evErr } = await supabase.from('fx_report_evidence').insert(stored);
        if (evErr) {
          await supabase.from('fx_reports').delete().eq('id', reportId);
          throw new Error(`Insert evidence: ${evErr.message}`);
        }

        await logEvent({ accountId: account.id, reportId, event: 'report_submitted', actor: 'account', detail: { category: report.category, files: stored.length }, ip: req.ip });
        const info = { reportId, subjectLabel: R.SUBJECT_TYPES[subjectType], subjectName: subject.name, categoryLabel: R.CATEGORIES[report.category].label, incidentDate: fmtDate(report.incident_date), dateLabel: (R.REPAYMENT_FIELDS[report.category] || {}).dateLabel || 'Incident date', fileCount: stored.length, isTest };
        const jobs = [sendEmail({ to: account.email, tag: 'fx-report-received', ...templates.reportReceived(account, info) })];
        if (process.env.ONBOARDING_NOTIFY_EMAIL && (!isTest || testNotificationsOn())) {
          jobs.push(sendEmail({ to: process.env.ONBOARDING_NOTIFY_EMAIL, tag: 'fx-admin-new-report', ...templates.adminNewReport(account, info) }));
        }
        (await Promise.allSettled(jobs)).forEach(r => { if (r.status === 'rejected') console.error(`Report ${reportId} email failed:`, r.reason.message); });
        setImmediate(() => AI.reviewReport(reportId, 'system')); // background; admin sees it on the report
        return res.redirect(303, `/reports/${reportId}?submitted=1`);
      } catch (err) {
        if (stored.length) await supabase.storage.from(BUCKET).remove(stored.map(s => s.storage_path)).catch(() => {});
        throw err;
      }
    } catch (err) { return next(err); }
  });
});

// One subject per identity: individuals by DOB + SSN last 4, funded businesses by EIN, partners by domain.
async function findOrCreateSubject(s) {
  let row = { subject_type: s.subject_type, name: s.name, contact_name: s.contact_name || null };
  let find;
  if (s.subject_type === 'individual') {
    const hash = blindIndex(`person:${s.dob}:${s.ssn_last4}`);
    find = () => supabase.from('fx_subjects').select('*').eq('subject_type', 'individual').eq('identity_hash', hash).maybeSingle();
    Object.assign(row, { dob_enc: encrypt(s.dob), ssn_last4_enc: encrypt(s.ssn_last4), identity_hash: hash });
  } else if (s.subject_type === 'merchant') {
    const hash = blindIndex(`ein:${s.ein}`);
    find = () => supabase.from('fx_subjects').select('*').eq('subject_type', 'merchant').eq('identity_hash', hash).maybeSingle();
    Object.assign(row, { dba: s.dba || null, ein_enc: encrypt(s.ein), identity_hash: hash });
  } else {
    find = () => supabase.from('fx_subjects').select('*').eq('subject_type', 'company').eq('domain', s.domain).maybeSingle();
    Object.assign(row, { website: s.website, domain: s.domain });
  }
  const { data: existing, error: findErr } = await find();
  if (findErr) throw new Error(`Find subject: ${findErr.message}`);
  if (existing) return existing;
  const { data: created, error: insErr } = await supabase.from('fx_subjects').insert(row).select('*').single();
  if (!insErr) return created;
  if (insErr.code === '23505') { const { data: again } = await find(); if (again) return again; }
  throw new Error(`Create subject: ${insErr.message}`);
}

// ---------- view ----------

router.get('/reports/:id', async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.redirect('/reports');
    const { data: report, error } = await supabase.from('fx_reports').select('*, fx_subjects(*)')
      .eq('id', req.params.id).eq('reporter_account_id', req.account.id).maybeSingle();
    if (error) throw new Error(`Load report: ${error.message}`);
    if (!report) return res.status(404).render('error', { pageTitle: 'Not found', message: 'That report does not exist.' });
    const { data: files } = await supabase.from('fx_report_evidence').select('id, kind, file_name, size_bytes').eq('report_id', report.id).order('created_at');
    const { data: notices } = await supabase.from('fx_notices').select('channel, email, status, created_at').eq('report_id', report.id).order('created_at', { ascending: false });
    const { data: dispute } = await supabase.from('fx_disputes').select('*').eq('report_id', report.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    let dFiles = [];
    if (dispute) { const { data } = await supabase.from('fx_dispute_files').select('id, party, file_name, size_bytes').eq('dispute_id', dispute.id).order('created_at'); dFiles = data || []; }
    res.render('reports/view', {
      pageTitle: 'Report', report, removable: D.REMOVABLE.includes(report.status), files: files || [], notices: notices || [], fmtDay: N.fmtDay, dispute, dFiles,
      submitted: req.query.submitted === '1', msg: typeof req.query.msg === 'string' ? req.query.msg : null, err: typeof req.query.err === 'string' ? req.query.err : null,
    });
  } catch (err) { next(err); }
});

// The reporter removes its own report (any time before it's removed, rejected or expired).
router.post('/reports/:id/remove', async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.redirect(303, '/reports');
    const out = await D.removeByReporter({ account: req.account, reportId: req.params.id, ip: req.ip });
    const q = out.error ? { err: out.error } : { msg: 'Report removed. It is no longer part of FinDex.' };
    res.redirect(303, `/reports/${req.params.id}?${new URLSearchParams(q)}`);
  } catch (err) { next(err); }
});

// Notice bounced: the reporter gives another email, which is sent right away. (No mailed letters.)
router.post('/reports/:id/contact', async (req, res, next) => {
  try {
    const back = (m, isErr) => `/reports/${req.params.id}?${new URLSearchParams(isErr ? { err: m } : { msg: m })}`;
    const { data: own } = await supabase.from('fx_reports').select('id').eq('id', req.params.id).eq('reporter_account_id', req.account.id).maybeSingle();
    if (!own) return res.redirect(303, '/reports');
    const report = await N.loadFull(own.id);
    if (report.status !== 'notice_undeliverable') return res.redirect(303, back('This report isn\u2019t waiting for a new email address.', true));
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) || email.length > 254) return res.redirect(303, back('Enter a valid email address.', true));
    const { data: tried } = await supabase.from('fx_notices').select('id').eq('report_id', report.id).eq('email', email).limit(1);
    if (tried && tried.length) return res.redirect(303, back('A notice was already sent to that email. Please try a different one.', true));
    await supabase.from('fx_reports').update({ notice_email: email }).eq('id', report.id);
    await supabase.from('fx_subject_emails').upsert({ subject_id: report.subject_id, email }, { onConflict: 'subject_id,email', ignoreDuplicates: true });
    await logEvent({ accountId: req.account.id, reportId: report.id, event: 'notice_resent', actor: 'account', ip: req.ip });
    const result = await N.sendEmailNotice({ ...report, notice_email: email }, email, { ip: req.ip, actor: 'account' });
    if (process.env.ONBOARDING_NOTIFY_EMAIL && (!report.is_test || testNotificationsOn())) {
      sendEmail({ to: process.env.ONBOARDING_NOTIFY_EMAIL, tag: 'fx-admin-notice-email', ...disputeEmails.contactToAdmin({
        reportId: report.id, reporterName: report.reporter.business_legal_name, subjectName: report.subject_name_reported, email, sent: result.ok, isTest: report.is_test }) })
        .catch(err => console.error(`New notice email to admin for ${report.id} failed:`, err.message));
    }
    return res.redirect(303, result.ok ? back(`Notice sent to ${email}. The 10 days start now.`) : back('That email couldn\u2019t be sent either. Please try another.', true));
  } catch (err) { next(err); }
});

router.post('/reports/:id/respond', (req, res, next) => {
  respUpload(req, res, async upErr => {
    try {
      const back = (m, isErr) => `/reports/${req.params.id}?${new URLSearchParams(isErr ? { err: m } : { msg: m })}`;
      if (upErr) return res.redirect(303, back(upErr.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 25 MB or smaller.' : `Up to ${D.MAX_DISPUTE_FILES} files.`, true));
      const response = typeof (req.body || {}).response === 'string' ? req.body.response.trim().slice(0, 5000) : '';
      if (response.length < 10 && !(req.files || []).length) return res.redirect(303, back('Add a response or supporting files.', true));
      const out = await D.respond({ account: req.account, reportId: req.params.id, response: response || '(files only)', files: req.files || [], ip: req.ip });
      res.redirect(303, out.error ? back(out.error, true) : back('Response sent. We\u2019ll email you the outcome.'));
    } catch (err) { next(err); }
  });
});

// Files the reported party attached to a dispute of this reporter's report.
router.get('/reports/:id/dispute-files/:fileId', async (req, res, next) => {
  try {
    const { data: own } = await supabase.from('fx_reports').select('id').eq('id', req.params.id).eq('reporter_account_id', req.account.id).maybeSingle();
    if (!own) return res.redirect('/reports');
    const { data: ds } = await supabase.from('fx_disputes').select('id').eq('report_id', own.id);
    const out = await D.signedFile(req.params.fileId, (ds || []).map(d => d.id));
    if (!out) return res.status(404).render('error', { pageTitle: 'Not found', message: 'That file does not exist.' });
    await logEvent({ accountId: req.account.id, reportId: own.id, event: 'dispute_file_viewed', actor: 'account', detail: { file: out.file.file_name }, ip: req.ip });
    res.redirect(out.url);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.STATUS_LABELS = STATUS_LABELS;
