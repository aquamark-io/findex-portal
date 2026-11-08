/**
 * Disputes: the reported party disputes a report (withheld at once, 30-day reinvestigation), the reporter
 * responds, and the admin resolves it: upheld, amended (description corrected) or removed. Both sides emailed.
 */
const crypto = require('crypto');
const supabase = require('./supabase');
const { sendEmail, disputeEmails } = require('./email');
const { logEvent } = require('./events');
const { testNotificationsOn } = require('./notify-admin');
const R = require('./reports');
const N = require('./notices');

const DISPUTE_DAYS = 30;
const MAX_DISPUTE_FILES = 5;
const DISPUTABLE = ['notice_sent', 'published'];

const adminOn = report => process.env.ONBOARDING_NOTIFY_EMAIL && (!report.is_test || testNotificationsOn());
const send = (job, what) => sendEmail(job).catch(err => console.error(`${what} email failed:`, err.message));

function info(report, dispute, extra = {}) {
  return {
    reportId: report.id, disputeId: dispute && dispute.id, subjectName: report.subject_name_reported,
    reporterName: report.reporter.business_legal_name, categoryLabel: R.CATEGORIES[report.category].label,
    dueDate: dispute ? N.fmtDay(dispute.due_at) : '', isTest: report.is_test, ...extra,
  };
}

async function storeFiles(disputeId, party, files) {
  const rows = [];
  for (const f of files) {
    const type = R.fileType(f);
    if (!type) throw Object.assign(new Error(`“${f.originalname}” isn’t an accepted file type.`), { userFacing: true });
    const id = crypto.randomUUID();
    const path = `disputes/${disputeId}/${id}/${R.safeName(f.originalname)}`;
    const { error } = await supabase.storage.from('fx-evidence').upload(path, f.buffer, { contentType: type, upsert: false });
    if (error) throw new Error(`Upload: ${error.message}`);
    rows.push({ id, dispute_id: disputeId, party, storage_path: path, file_name: f.originalname.slice(0, 200), mime_type: type, size_bytes: f.size, sha256: R.sha256(f.buffer) });
  }
  if (rows.length) {
    const { error } = await supabase.from('fx_dispute_files').insert(rows);
    if (error) throw new Error(`Save dispute files: ${error.message}`);
  }
  return rows.length;
}

async function openDispute({ account, reportId, reason, files, ip }) {
  const report = await N.loadFull(reportId);
  if (!report || !DISPUTABLE.includes(report.status)) return { error: 'This report can’t be disputed right now.' };
  const dueAt = new Date(Date.now() + DISPUTE_DAYS * 24 * 3600 * 1000);
  const { data: dispute, error } = await supabase.from('fx_disputes').insert({
    report_id: report.id, account_id: account.id, reason, prior_status: report.status, due_at: dueAt.toISOString(),
  }).select('*').single();
  if (error) {
    if (error.code === '23505') return { error: 'This report is already being disputed.' };
    throw new Error(`Open dispute: ${error.message}`);
  }
  try { await storeFiles(dispute.id, 'subject', files); } catch (err) {
    await supabase.from('fx_disputes').delete().eq('id', dispute.id);
    if (err.userFacing) return { error: err.message };
    throw err;
  }
  await supabase.from('fx_reports').update({ status: 'disputed' }).eq('id', report.id);
  await logEvent({ accountId: account.id, reportId: report.id, event: 'dispute_opened', actor: 'account', ip });
  const i = info(report, dispute);
  await Promise.all([
    send({ to: account.email, tag: 'fx-dispute-received', ...disputeEmails.toSubjectOpened(account, i) }, 'Dispute received'),
    send({ to: report.reporter.email, tag: 'fx-dispute-reporter', ...disputeEmails.toReporterOpened(report.reporter, i) }, 'Dispute to reporter'),
    adminOn(report) ? send({ to: process.env.ONBOARDING_NOTIFY_EMAIL, tag: 'fx-admin-dispute', ...disputeEmails.toAdminOpened(i) }, 'Dispute to admin') : null,
  ]);
  return { dispute };
}

async function respond({ account, reportId, response, files, ip }) {
  const report = await N.loadFull(reportId);
  if (!report || report.reporter_account_id !== account.id) return { error: 'Report not found.' };
  const { data: dispute } = await supabase.from('fx_disputes').select('*').eq('report_id', report.id).eq('status', 'open').maybeSingle();
  if (!dispute) return { error: 'There is no open dispute on this report.' };
  try { await storeFiles(dispute.id, 'reporter', files); } catch (err) { if (err.userFacing) return { error: err.message }; throw err; }
  const combined = dispute.reporter_response ? `${dispute.reporter_response}\n\n---\n${response}` : response;
  await supabase.from('fx_disputes').update({ reporter_response: combined.slice(0, 20000), reporter_responded_at: new Date().toISOString() }).eq('id', dispute.id);
  await logEvent({ accountId: account.id, reportId: report.id, event: 'dispute_response', actor: 'account', ip });
  if (adminOn(report)) await send({ to: process.env.ONBOARDING_NOTIFY_EMAIL, tag: 'fx-admin-dispute-response', ...disputeEmails.toAdminResponded(info(report, dispute)) }, 'Dispute response');
  return { ok: true };
}

async function resolve({ reportId, outcome, note, amendedDescription, ip }) {
  const report = await N.loadFull(reportId);
  const { data: dispute } = await supabase.from('fx_disputes').select('*').eq('report_id', reportId).eq('status', 'open').maybeSingle();
  if (!report || !dispute) return { error: 'There is no open dispute on this report.' };
  const now = new Date().toISOString();
  const { data: claimed } = await supabase.from('fx_disputes').update({ status: outcome, resolution_note: note, resolved_at: now })
    .eq('id', dispute.id).eq('status', 'open').select('id').maybeSingle();
  if (!claimed) return { error: 'This dispute changed while you were viewing it.' };
  const update = outcome === 'removed'
    ? { status: 'removed', removed_at: now }
    : { status: 'published', published_at: report.published_at || now, ...(outcome === 'amended' ? { description: amendedDescription } : {}) };
  const { error } = await supabase.from('fx_reports').update(update).eq('id', report.id);
  if (error) throw new Error(`Resolve: ${error.message}`);
  await logEvent({ reportId: report.id, event: `dispute_${outcome}`, actor: 'admin', ip });
  const i = info(report, dispute, { outcome, note });
  const { data: subjectAcct } = await supabase.from('fx_accounts').select('*').eq('id', dispute.account_id).maybeSingle();
  await Promise.all([
    subjectAcct ? send({ to: subjectAcct.email, tag: 'fx-dispute-resolved', ...disputeEmails.resolved(subjectAcct, i, false) }, 'Resolution to subject') : null,
    send({ to: report.reporter.email, tag: 'fx-dispute-resolved', ...disputeEmails.resolved(report.reporter, i, true) }, 'Resolution to reporter'),
  ]);
  return { ok: true };
}

// Daily: remind the admin about disputes due within 5 days or overdue.
async function remindDue() {
  const soon = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
  const { data } = await supabase.from('fx_disputes').select('due_at, fx_reports(subject_name_reported, is_test)').eq('status', 'open').lte('due_at', soon).order('due_at');
  const list = (data || []).filter(d => d.fx_reports && (!d.fx_reports.is_test || testNotificationsOn()))
    .map(d => ({ subjectName: d.fx_reports.subject_name_reported, dueDate: N.fmtDay(d.due_at), overdue: new Date(d.due_at) < new Date() }));
  if (list.length && process.env.ONBOARDING_NOTIFY_EMAIL) await send({ to: process.env.ONBOARDING_NOTIFY_EMAIL, tag: 'fx-admin-disputes-due', ...disputeEmails.dueSoon(list) }, 'Disputes due');
  return list.length;
}

async function signedFile(fileId, disputeIds) {
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return null;
  const { data: f } = await supabase.from('fx_dispute_files').select('*').eq('id', fileId).maybeSingle();
  if (!f || (disputeIds && !disputeIds.includes(f.dispute_id))) return null;
  const { data, error } = await supabase.storage.from('fx-evidence').createSignedUrl(f.storage_path, 120);
  if (error) throw new Error(`Signed URL: ${error.message}`);
  return { file: f, url: data.signedUrl };
}

// The reporting company removes its own report, at any stage before it's removed, rejected or expired.
const REMOVABLE = ['submitted', 'notice_sent', 'notice_undeliverable', 'published', 'disputed'];
async function removeByReporter({ account, reportId, ip }) {
  const report = await N.loadFull(reportId);
  if (!report || report.reporter_account_id !== account.id) return { error: 'Report not found.' };
  if (!REMOVABLE.includes(report.status)) return { error: 'This report can\u2019t be removed.' };
  const now = new Date().toISOString();
  const { data: claimed, error } = await supabase.from('fx_reports').update({ status: 'removed', removed_at: now })
    .eq('id', report.id).eq('status', report.status).select('id').maybeSingle();
  if (error) throw new Error(`Remove report: ${error.message}`);
  if (!claimed) return { error: 'This report changed while you were viewing it. Please try again.' };
  const { data: dispute } = await supabase.from('fx_disputes').update({ status: 'removed', resolution_note: 'Removed by the reporting company.', resolved_at: now })
    .eq('report_id', report.id).eq('status', 'open').select('account_id').maybeSingle();
  await logEvent({ accountId: account.id, reportId: report.id, event: 'report_removed_by_reporter', actor: 'account', ip });
  const i = { reportId: report.id, reporterName: report.reporter.business_legal_name, categoryLabel: R.CATEGORIES[report.category].label,
    subjectName: report.subject_name_reported, isTest: report.is_test, hadDispute: !!dispute };
  // The reported party only hears about it if they were notified of the report in the first place.
  const to = new Set();
  if (report.status !== 'submitted' && report.notice_email) to.add(report.notice_email.toLowerCase());
  if (dispute) {
    const { data: acct } = await supabase.from('fx_accounts').select('email').eq('id', dispute.account_id).maybeSingle();
    if (acct && acct.email) to.add(acct.email.toLowerCase());
  }
  const subjectName = report.fx_subjects && report.fx_subjects.subject_type === 'individual' ? report.subject_name_reported : (report.fx_subjects && report.fx_subjects.contact_name) || '';
  await Promise.all([
    ...[...to].map(email => send({ to: email, tag: 'fx-report-removed', ...disputeEmails.removedToSubject({ ...i, subjectName }) }, 'Removal to subject')),
    adminOn(report) ? send({ to: process.env.ONBOARDING_NOTIFY_EMAIL, tag: 'fx-admin-report-removed', ...disputeEmails.removedToAdmin(i) }, 'Removal to admin') : null,
  ]);
  return { ok: true };
}

module.exports = { DISPUTE_DAYS, MAX_DISPUTE_FILES, DISPUTABLE, REMOVABLE, openDispute, respond, resolve, remindDue, signedFile, removeByReporter };
