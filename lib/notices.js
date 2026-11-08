/**
 * Notices to reported parties, bounce handling, the daily publishing job, and linking reported parties
 * (fx_subjects) to their own accounts.
 */
const supabase = require('./supabase');
const { sendEmail, templates } = require('./email');
const { logEvent } = require('./events');

const { testNotificationsOn } = require('./notify-admin');
const { CATEGORIES } = require('./reports');

const NOTICE_DAYS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const fmtDay = d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
const fmtIncident = d => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

async function loadFull(reportId) {
  const { data, error } = await supabase.from('fx_reports')
    .select('*, fx_subjects(*), reporter:fx_accounts!fx_reports_reporter_account_id_fkey(*)').eq('id', reportId).maybeSingle();
  if (error) throw new Error(`Load report: ${error.message}`);
  return data;
}

function adminCopy(report) {
  return process.env.ONBOARDING_NOTIFY_EMAIL && (!report.is_test || testNotificationsOn());
}

/**
 * Sends the notice email and starts the 10-day window, or marks the report undeliverable if Postmark
 * refuses the address. `startFrom` lets a mailed letter start the clock from the mailing date.
 * Returns { ok, notice }.
 */
async function sendEmailNotice(report, email, { ip = null, actor = 'admin' } = {}) {
  const now = new Date();
  const publishAt = new Date(now.getTime() + NOTICE_DAYS * DAY_MS);
  const info = {
    subjectType: report.fx_subjects.subject_type,
    subjectName: report.fx_subjects.subject_type === 'individual' ? report.subject_name_reported : (report.fx_subjects.contact_name || ''),
    reporterName: report.reporter.business_legal_name,
    categoryLabel: CATEGORIES[report.category].label,
    incidentDate: fmtIncident(report.incident_date),
    description: report.description,
    publishDate: fmtDay(publishAt),
  };
  let messageId = null, failure = null;
  try {
    const res = await sendEmail({ to: email, tag: 'fx-notice', ...templates.noticeToSubject(info) });
    messageId = res.MessageID || null;
  } catch (err) {
    failure = err.message;
    console.error(`Notice for report ${report.id} failed:`, err.message);
  }
  const { data: notice, error: nErr } = await supabase.from('fx_notices').insert({
    report_id: report.id, channel: 'email', email, status: failure ? 'failed' : 'sent',
    postmark_message_id: messageId, bounce_detail: failure ? failure.slice(0, 500) : null, sent_at: failure ? null : now.toISOString(),
  }).select('*').single();
  if (nErr) throw new Error(`Insert notice: ${nErr.message}`);

  if (failure) {
    await supabase.from('fx_reports').update({ status: 'notice_undeliverable', notice_sent_at: null, publish_at: null }).eq('id', report.id);
    await logEvent({ reportId: report.id, event: 'notice_failed', actor: 'system', detail: { channel: 'email' }, ip });
    await askReporterForContact(report, email);
    return { ok: false, notice };
  }
  await supabase.from('fx_reports').update({ status: 'notice_sent', notice_sent_at: now.toISOString(), publish_at: publishAt.toISOString() }).eq('id', report.id);
  await logEvent({ reportId: report.id, event: 'notice_sent', actor, detail: { channel: 'email', publish_at: publishAt.toISOString() }, ip });
  return { ok: true, notice, publishAt };
}

async function askReporterForContact(report, email) {
  const info = { reportId: report.id, subjectName: report.subject_name_reported, email, isTest: report.is_test };
  const jobs = [sendEmail({ to: report.reporter.email, tag: 'fx-notice-undeliverable', ...templates.noticeUndeliverable(report.reporter, info) })];
  if (adminCopy(report)) jobs.push(sendEmail({ to: process.env.ONBOARDING_NOTIFY_EMAIL, tag: 'fx-admin-notice-bounced', ...templates.adminNotice('bounced', info) }));
  (await Promise.allSettled(jobs)).forEach(r => { if (r.status === 'rejected') console.error(`Undeliverable emails for ${report.id}:`, r.reason.message); });
}

/** Postmark bounce webhook payload -> mark the notice bounced and pause the report. */
async function handleBounce(payload) {
  const hard = payload && (payload.Inactive === true || ['HardBounce', 'BadEmailAddress', 'SpamNotification', 'ManuallyDeactivated', 'Blocked'].includes(payload.Type));
  if (!payload || !payload.MessageID || !hard) return 'ignored';
  const { data: notice } = await supabase.from('fx_notices').select('*').eq('postmark_message_id', String(payload.MessageID)).maybeSingle();
  if (!notice) return 'not_a_notice';
  if (notice.status === 'bounced') return 'already';
  await supabase.from('fx_notices').update({ status: 'bounced', bounced_at: new Date().toISOString(), bounce_detail: String(payload.Description || payload.Type || '').slice(0, 500) }).eq('id', notice.id);
  const report = await loadFull(notice.report_id);
  if (!report || report.status !== 'notice_sent') return 'report_not_waiting';
  // Only pause if this is the most recent notice.
  const { data: latest } = await supabase.from('fx_notices').select('id').eq('report_id', report.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (latest && latest.id !== notice.id) return 'older_notice';
  await supabase.from('fx_reports').update({ status: 'notice_undeliverable', publish_at: null }).eq('id', report.id);
  await logEvent({ reportId: report.id, event: 'notice_bounced', actor: 'system', detail: { type: payload.Type || null } });
  await askReporterForContact(report, notice.email);
  return 'paused';
}

/** Reporter gave a mailing address: queue a letter for the admin to post. */
async function queueLetter(report, address, ip) {
  const { error } = await supabase.from('fx_notices').insert({ report_id: report.id, channel: 'mail', mailing_address: address, status: 'to_mail' });
  if (error) throw new Error(`Queue letter: ${error.message}`);
  await logEvent({ reportId: report.id, event: 'letter_requested', actor: 'account', ip });
  if (adminCopy(report)) {
    await sendEmail({ to: process.env.ONBOARDING_NOTIFY_EMAIL, tag: 'fx-admin-letter', ...templates.adminNotice('to_mail', { reportId: report.id, subjectName: report.subject_name_reported, isTest: report.is_test }) })
      .catch(err => console.error(`Letter email for ${report.id} failed:`, err.message));
  }
}

/** Admin posted the letter: the 10 days start from now. */
async function markMailed(report, noticeId, ip) {
  const now = new Date();
  const publishAt = new Date(now.getTime() + NOTICE_DAYS * DAY_MS);
  const { data: n } = await supabase.from('fx_notices').update({ status: 'mailed', mailed_at: now.toISOString() })
    .eq('id', noticeId).eq('report_id', report.id).eq('status', 'to_mail').select('id').maybeSingle();
  if (!n) return false;
  await supabase.from('fx_reports').update({ status: 'notice_sent', notice_sent_at: now.toISOString(), publish_at: publishAt.toISOString() }).eq('id', report.id);
  await logEvent({ reportId: report.id, event: 'notice_mailed', actor: 'admin', detail: { publish_at: publishAt.toISOString() }, ip });
  return publishAt;
}

/** Daily job: publish reports whose 10-day window has passed. */
async function publishDue() {
  const { data: due, error } = await supabase.from('fx_reports').select('id').eq('status', 'notice_sent').lte('publish_at', new Date().toISOString()).limit(500);
  if (error) throw new Error(`Due reports: ${error.message}`);
  let published = 0;
  for (const { id } of due || []) {
    const { data: upd } = await supabase.from('fx_reports').update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'notice_sent').select('id').maybeSingle();
    if (!upd) continue;
    published++;
    const report = await loadFull(id);
    await logEvent({ reportId: id, event: 'report_published', actor: 'system' });
    await sendEmail({ to: report.reporter.email, tag: 'fx-report-published', ...templates.reportPublished(report.reporter, { reportId: id, subjectName: report.subject_name_reported, categoryLabel: CATEGORIES[report.category].label }) })
      .catch(err => console.error(`Published email for ${id} failed:`, err.message));
  }
  return published;
}

/**
 * Daily: permanently delete reports whose incident is more than 7 years old (expires_on reached), with their
 * evidence, notices and dispute files. Reports with an open dispute wait until it is resolved.
 */
async function deleteExpired() {
  const today = new Date().toISOString().slice(0, 10);
  const { data: due, error } = await supabase.from('fx_reports').select('id, subject_id, category').lte('expires_on', today).limit(200);
  if (error) throw new Error(`Expired reports: ${error.message}`);
  let deleted = 0;
  for (const r of due || []) {
    const { data: open } = await supabase.from('fx_disputes').select('id').eq('report_id', r.id).eq('status', 'open').limit(1);
    if (open && open.length) continue;
    const { data: ev } = await supabase.from('fx_report_evidence').select('storage_path').eq('report_id', r.id);
    const { data: ds } = await supabase.from('fx_disputes').select('id').eq('report_id', r.id);
    let paths = (ev || []).map(f => f.storage_path);
    if (ds && ds.length) {
      const { data: df } = await supabase.from('fx_dispute_files').select('storage_path').in('dispute_id', ds.map(d => d.id));
      paths = paths.concat((df || []).map(f => f.storage_path));
    }
    if (paths.length) {
      const { error: sErr } = await supabase.storage.from('fx-evidence').remove(paths);
      if (sErr) { console.error(`Retention: files for ${r.id} not removed:`, sErr.message); continue; }
    }
    const { error: dErr } = await supabase.from('fx_reports').delete().eq('id', r.id);
    if (dErr) { console.error(`Retention: report ${r.id} not deleted:`, dErr.message); continue; }
    await logEvent({ event: 'report_expired_deleted', actor: 'system', detail: { category: r.category, files: paths.length } });
    deleted++;
  }
  return deleted;
}

// Runs once a day after 6 AM Pacific (checked every 15 minutes; a log entry stops it running twice).
function startDailyJob() {
  const tick = async () => {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date()).map(p => [p.type, p.value]));
      if (Number(parts.hour) < 6) return;
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      const { count } = await supabase.from('fx_events').select('id', { count: 'exact', head: true }).eq('event', 'daily_job').eq('detail->>day', day);
      if (count) return;
      await logEvent({ event: 'daily_job', actor: 'system', detail: { day, started: true } });
      const published = await publishDue();
      const due = await require('./disputes').remindDue();
      const expired = await deleteExpired();
      console.log(`Daily job ${day}: published ${published}, disputes due soon ${due}, expired deleted ${expired}`);
    } catch (err) {
      console.error('Daily job failed:', err.message);
    }
  };
  setTimeout(tick, 30 * 1000);
  return setInterval(tick, 15 * 60 * 1000);
}

/**
 * Connects an approved account to reports about it. Matches:
 *   individual: notice email = account email, or DOB + SSN last 4
 *   merchant:   notice email = account email, or EIN
 *   company:    notice email = account email, or website domain = verified email domain
 */
async function autoLink(account) {
  try {
    const type = account.account_type;
    const found = new Map();
    const { data: byEmail } = await supabase.from('fx_subject_emails').select('subject_id, fx_subjects!inner(subject_type)')
      .eq('email', account.email).eq('fx_subjects.subject_type', type);
    (byEmail || []).forEach(r => found.set(r.subject_id, 'email'));
    if ((type === 'individual' || type === 'merchant') && account.identity_hash) {
      const { data } = await supabase.from('fx_subjects').select('id').eq('subject_type', type).eq('identity_hash', account.identity_hash);
      (data || []).forEach(r => found.set(r.id, 'identity'));
    }
    if (type === 'company' && account.email_domain) {
      const { data } = await supabase.from('fx_subjects').select('id').eq('subject_type', 'company').eq('domain', account.email_domain);
      (data || []).forEach(r => found.set(r.id, 'domain'));
    }
    if (!found.size) return;
    const rows = [...found].map(([subject_id, linked_by]) => ({ subject_id, account_id: account.id, linked_by }));
    const { error } = await supabase.from('fx_subject_links').upsert(rows, { onConflict: 'subject_id,account_id', ignoreDuplicates: true });
    if (error) console.error('Auto-link failed:', error.message);
  } catch (err) {
    console.error('Auto-link failed:', err.message);
  }
}

// Statuses a reported party can see. (Disputed will be added in step 4.)
const VISIBLE_TO_SUBJECT = ['notice_sent', 'published', 'notice_undeliverable', 'disputed'];

async function reportsAboutAccount(accountId) {
  const { data: links } = await supabase.from('fx_subject_links').select('subject_id').eq('account_id', accountId);
  const ids = (links || []).map(l => l.subject_id);
  if (!ids.length) return [];
  const { data, error } = await supabase.from('fx_reports')
    .select('id, category, incident_date, description, status, publish_at, published_at, subject_id, reporter:fx_accounts!fx_reports_reporter_account_id_fkey(business_legal_name)')
    .in('subject_id', ids).in('status', VISIBLE_TO_SUBJECT).order('created_at', { ascending: false });
  if (error) throw new Error(`Reports about account: ${error.message}`);
  return data || [];
}

// Searches that showed this account a report about itself (FCRA: who obtained my report).
async function viewersOfAccount(accountId) {
  const { data: links } = await supabase.from('fx_subject_links').select('subject_id').eq('account_id', accountId);
  const ids = (links || []).map(l => l.subject_id);
  if (!ids.length) return [];
  const { data, error } = await supabase.from('fx_searches').select('id, purpose, created_at, result_report_ids, fx_accounts(business_legal_name)')
    .overlaps('matched_subject_ids', ids).order('created_at', { ascending: false }).limit(200);
  if (error) throw new Error(`Viewers: ${error.message}`);
  return (data || []).filter(s => s.result_report_ids && s.result_report_ids.length);
}

module.exports = { deleteExpired, viewersOfAccount, NOTICE_DAYS, fmtDay, loadFull, sendEmailNotice, handleBounce, queueLetter, markMailed, publishDue, startDailyJob, autoLink, reportsAboutAccount, VISIBLE_TO_SUBJECT };
