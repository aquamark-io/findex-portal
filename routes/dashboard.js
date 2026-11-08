// Dashboards (placeholders until search, reporting and disputes are built), plus the
// "Get full access" upgrade for companies that signed up through Check My Record.
const express = require('express');
const supabase = require('../lib/supabase');
const { requireAccount } = require('../middleware/auth');
const { COMPANY_TYPES } = require('../lib/validate');
const { canReportRepayment, CATEGORIES, fmtSize } = require('../lib/reports');
const N = require('../lib/notices');
const { CFPB_SUMMARY_URL } = require('../lib/email');
const { MEMBER_TERMS_VERSION, INDEMNIFICATION } = require('../lib/terms');
const { logEvent } = require('../lib/events');
const { sendEmail, templates } = require('../lib/email');
const { testNotificationsOn } = require('../lib/notify-admin');

const router = express.Router();

const canUpgrade = a => a.account_type === 'company' && !a.terms_version;

router.get('/dashboard', requireAccount, async (req, res, next) => {
  const a = req.account;
  let aboutMe = [];
  let files = {};
  try {
    const { data: full } = await supabase.from('fx_accounts').select('*').eq('id', a.id).maybeSingle();
    if (full) await N.autoLink(full);
    aboutMe = await N.reportsAboutAccount(a.id);
    if (aboutMe.length) {
      const { data: ev } = await supabase.from('fx_report_evidence').select('id, report_id, file_name, size_bytes').in('report_id', aboutMe.map(r => r.id)).order('created_at');
      (ev || []).forEach(f => { (files[f.report_id] = files[f.report_id] || []).push(f); });
    }
  } catch (err) { return next(err); }
  res.render('dashboard', {
    aboutMe, aboutFiles: files, CATEGORIES, fmtDay: N.fmtDay, fmtSize, CFPB_SUMMARY_URL,
    disputeEmail: process.env.ONBOARDING_NOTIFY_EMAIL || '',
    pageTitle: 'Dashboard',
    COMPANY_TYPES,
    // Funders and lenders with full access may report funded-business repayment issues.
    canReportRepayment: a.account_type === 'company' && canReportRepayment(a) && Boolean(a.terms_version),
    msg: req.query.upgraded === '1' ? 'You now have full access.' : null,
  });
});

router.get('/dashboard/full-access', requireAccount, (req, res) => {
  if (!canUpgrade(req.account)) return res.redirect('/dashboard');
  res.render('full-access', { pageTitle: 'Get full access', INDEMNIFICATION, error: null });
});

router.post('/dashboard/full-access', requireAccount, async (req, res, next) => {
  const a = req.account;
  if (!canUpgrade(a)) return res.redirect(303, '/dashboard');
  if (req.body.authorize !== 'on' || req.body.member_terms !== 'on') {
    return res.status(422).render('full-access', {
      pageTitle: 'Get full access', INDEMNIFICATION,
      error: 'Please tick both boxes to get full access.',
    });
  }
  try {
    const { data: updated, error } = await supabase.from('fx_accounts')
      .update({ terms_version: MEMBER_TERMS_VERSION, terms_accepted_at: new Date().toISOString() })
      .eq('id', a.id).is('terms_version', null).select('*').maybeSingle();
    if (error) throw new Error(`Full access: ${error.message}`);
    if (!updated) return res.redirect(303, '/dashboard');

    await logEvent({ accountId: a.id, event: 'full_access_accepted', actor: 'account', detail: { terms_version: MEMBER_TERMS_VERSION }, ip: req.ip });
    if (process.env.ONBOARDING_NOTIFY_EMAIL && (!updated.is_test || testNotificationsOn())) {
      sendEmail({ to: process.env.ONBOARDING_NOTIFY_EMAIL, tag: 'fx-admin-full-access', ...templates.adminFullAccess(updated) })
        .catch(err => console.error(`Full-access email for account ${a.id} failed:`, err.message));
    }
    return res.redirect(303, '/dashboard?upgraded=1');
  } catch (err) {
    return next(err);
  }
});

// Evidence for a report about the signed-in account: short-lived signed link, logged.
router.get('/my-record/files/:fileId', requireAccount, async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.fileId)) return res.redirect('/dashboard');
    const { data: f } = await supabase.from('fx_report_evidence').select('id, report_id, storage_path, file_name').eq('id', req.params.fileId).maybeSingle();
    if (!f) return res.redirect('/dashboard');
    const mine = (await N.reportsAboutAccount(req.account.id)).some(r => r.id === f.report_id);
    if (!mine) return res.status(404).render('error', { pageTitle: 'Not found', message: 'That file does not exist.' });
    const { data, error } = await supabase.storage.from('fx-evidence').createSignedUrl(f.storage_path, 120);
    if (error) throw new Error(`Signed URL: ${error.message}`);
    await logEvent({ accountId: req.account.id, reportId: f.report_id, event: 'subject_evidence_viewed', actor: 'account', detail: { file: f.file_name }, ip: req.ip });
    res.redirect(data.signedUrl);
  } catch (err) { next(err); }
});

module.exports = router;
