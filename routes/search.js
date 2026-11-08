/**
 * Search (companies with full access).
 *   GET  /search                 who are you searching for? + your recent searches
 *   GET  /search/:who            search form (individual | partner | funded-business)
 *   POST /search/:who            validate, upload employment authorization, run, log, show results
 *   GET  /search/results/:id     results of one of your searches (for 7 days)
 *   GET  /search/results/:id/files/:fileId   evidence from those results (signed link, logged)
 */
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const supabase = require('../lib/supabase');
const { requireAccount } = require('../middleware/auth');
const { logEvent } = require('../lib/events');
const { CFPB_SUMMARY_URL } = require('../lib/email');
const R = require('../lib/reports');
const S = require('../lib/search');

const router = express.Router();
const RESULTS_DAYS = 7;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: R.MAX_FILE_BYTES, files: 1, fields: 30 } }).single('authorization');
const searchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => (req.account ? `acct:${req.account.id}` : req.ip),
  handler: (req, res) => res.status(429).render('error', { pageTitle: 'Too many searches', message: 'Your company has reached the search limit (60 per hour). Please try again later.' }),
});

function requireSearcher(req, res, next) {
  const a = req.account;
  if (a.account_type === 'company' && a.terms_version) return next();
  return res.redirect('/dashboard');
}

const fmtDate = d => {
  if (!d) return '';
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  return String(d).length <= 10 ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' })
    : new Date(d).toLocaleDateString('en-US', { ...opts, timeZone: 'America/Los_Angeles' });
};

router.use('/search', requireAccount, requireSearcher, (req, res, next) => {
  Object.assign(res.locals, { R, S, fmtDate, CFPB_SUMMARY_URL });
  next();
});

router.get('/search', async (req, res, next) => {
  try {
    const { data } = await supabase.from('fx_searches').select('id, subject_type, purpose, criteria, result_report_ids, created_at')
      .eq('account_id', req.account.id).order('created_at', { ascending: false }).limit(25);
    res.render('search/choose', { pageTitle: 'Search', recent: data || [] });
  } catch (err) { next(err); }
});

function renderForm(res, { who, subjectType, values = {}, errors = [], status = 200 }) {
  const safe = { ...values }; delete safe.dob; delete safe.ssn_last4; delete safe.ein;
  res.status(status).render('search/form', { pageTitle: 'Search', who, subjectType, values: safe, errors });
}

router.get('/search/:who', (req, res) => {
  const subjectType = R.SUBJECT_SLUG[req.params.who];
  if (!subjectType) return res.redirect('/search');
  renderForm(res, { who: req.params.who, subjectType });
});

router.post('/search/:who', searchLimiter, (req, res, next) => {
  const subjectType = R.SUBJECT_SLUG[req.params.who];
  if (!subjectType) return res.redirect(303, '/search');
  upload(req, res, async upErr => {
    const who = req.params.who;
    const body = req.body || {};
    if (upErr) return renderForm(res, { who, subjectType, values: body, errors: [upErr.code === 'LIMIT_FILE_SIZE' ? 'The authorization file must be 25 MB or smaller.' : 'The upload could not be read. Please try again.'], status: 422 });
    try {
      const { errors, q } = S.validateSearch(body, subjectType);
      let authFile = null;
      if (q.purpose === 'employment') {
        if (subjectType !== 'individual') errors.push('Employment screening applies to individuals only.');
        else if (!req.file) errors.push('Upload the signed disclosure and authorization form.');
        else {
          const type = R.fileType(req.file);
          if (!type || !['application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/webp'].includes(type)) errors.push('The authorization must be a PDF or an image.');
          else authFile = { file: req.file, mime: type };
        }
      }
      if (errors.length) return renderForm(res, { who, subjectType, values: body, errors, status: 422 });

      let authorizationId = null;
      if (authFile) {
        authorizationId = crypto.randomUUID();
        const path = `authorizations/${authorizationId}/${R.safeName(authFile.file.originalname)}`;
        const { error: sErr } = await supabase.storage.from('fx-evidence').upload(path, authFile.file.buffer, { contentType: authFile.mime, upsert: false });
        if (sErr) throw new Error(`Upload authorization: ${sErr.message}`);
        const { error: aErr } = await supabase.from('fx_authorizations').insert({
          id: authorizationId, account_id: req.account.id, storage_path: path, file_name: authFile.file.originalname.slice(0, 200),
          mime_type: authFile.mime, size_bytes: authFile.file.size, sha256: R.sha256(authFile.file.buffer),
        });
        if (aErr) { await supabase.storage.from('fx-evidence').remove([path]).catch(() => {}); throw new Error(`Save authorization: ${aErr.message}`); }
      }

      const subjectIds = await S.findSubjects(subjectType, q);
      const reports = await S.publishedReportsFor(subjectIds);
      const searchId = crypto.randomUUID();
      const { error: lErr } = await supabase.from('fx_searches').insert({
        id: searchId, account_id: req.account.id, subject_type: subjectType, purpose: q.purpose, criteria: S.criteriaForLog(q),
        matched_subject_ids: subjectIds, result_report_ids: reports.map(r => r.id), authorization_id: authorizationId,
        certified_at: new Date().toISOString(), ip: req.ip,
      });
      if (lErr) throw new Error(`Log search: ${lErr.message}`);
      return res.redirect(303, `/search/results/${searchId}`);
    } catch (err) { return next(err); }
  });
});

async function loadOwnSearch(req) {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return null;
  const { data } = await supabase.from('fx_searches').select('*').eq('id', req.params.id).eq('account_id', req.account.id).maybeSingle();
  if (!data) return null;
  data.expired = Date.now() - new Date(data.created_at).getTime() > RESULTS_DAYS * 24 * 3600 * 1000;
  return data;
}

router.get('/search/results/:id', async (req, res, next) => {
  try {
    const search = await loadOwnSearch(req);
    if (!search) return res.status(404).render('error', { pageTitle: 'Not found', message: 'That search does not exist.' });
    let reports = [], files = {};
    if (!search.expired && search.result_report_ids.length) {
      // Re-check: anything disputed or removed since the search is no longer shown.
      const { data } = await supabase.from('fx_reports')
        .select('id, category, incident_date, description, published_at, missed_count, payment_frequency, delinquency_status, caught_up_on, subject_name_reported, reporter:fx_accounts!fx_reports_reporter_account_id_fkey(business_legal_name, company_type)')
        .in('id', search.result_report_ids).eq('status', 'published').order('incident_date', { ascending: false });
      reports = data || [];
      if (reports.length) {
        const { data: ev } = await supabase.from('fx_report_evidence').select('id, report_id, file_name, size_bytes').in('report_id', reports.map(r => r.id)).order('created_at');
        (ev || []).forEach(f => { (files[f.report_id] = files[f.report_id] || []).push(f); });
      }
    }
    res.render('search/results', { pageTitle: 'Search results', search, reports, files, resultsDays: RESULTS_DAYS });
  } catch (err) { next(err); }
});

router.get('/search/results/:id/files/:fileId', async (req, res, next) => {
  try {
    const search = await loadOwnSearch(req);
    if (!search || search.expired || !/^[0-9a-f-]{36}$/i.test(req.params.fileId)) return res.redirect('/search');
    const { data: f } = await supabase.from('fx_report_evidence').select('id, report_id, storage_path, file_name').eq('id', req.params.fileId).maybeSingle();
    if (!f || !search.result_report_ids.includes(f.report_id)) return res.status(404).render('error', { pageTitle: 'Not found', message: 'That file does not exist.' });
    const { data: rep } = await supabase.from('fx_reports').select('status').eq('id', f.report_id).maybeSingle();
    if (!rep || rep.status !== 'published') return res.status(404).render('error', { pageTitle: 'Not available', message: 'This report is no longer published.' });
    const { data, error } = await supabase.storage.from('fx-evidence').createSignedUrl(f.storage_path, 120);
    if (error) throw new Error(`Signed URL: ${error.message}`);
    await logEvent({ accountId: req.account.id, reportId: f.report_id, event: 'search_evidence_viewed', actor: 'account', detail: { file: f.file_name, search_id: search.id }, ip: req.ip });
    res.redirect(data.signedUrl);
  } catch (err) { next(err); }
});

module.exports = router;
