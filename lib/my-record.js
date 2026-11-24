/**
 * "Reports about you" for the signed-in account: the reports, their evidence and open disputes, and who viewed the
 * record. Shown on the dashboard, or for companies with full access on the Reports tab (views/partials/about-me.ejs).
 */
const supabase = require('./supabase');
const N = require('./notices');
const D = require('./disputes');
const { CATEGORIES, fmtSize } = require('./reports');
const { PURPOSES } = require('./search');
const { CFPB_SUMMARY_URL } = require('./email');

// Companies with full access see their record on the Reports tab; everyone else on the dashboard.
const recordOnReportsTab = a => a.account_type === 'company' && Boolean(a.terms_version);

async function loadMyRecord(accountId) {
  const { data: full } = await supabase.from('fx_accounts').select('*').eq('id', accountId).maybeSingle();
  if (full) await N.autoLink(full); // links reports about this account when the details match
  const aboutMe = await N.reportsAboutAccount(accountId);
  const viewers = await N.viewersOfAccount(accountId);
  const disputes = {};
  const aboutFiles = {};
  if (aboutMe.length) {
    const ids = aboutMe.map(r => r.id);
    const { data: ev } = await supabase.from('fx_report_evidence').select('id, report_id, file_name, size_bytes').in('report_id', ids).order('created_at');
    (ev || []).forEach(f => { (aboutFiles[f.report_id] = aboutFiles[f.report_id] || []).push(f); });
    const { data: ds } = await supabase.from('fx_disputes').select('report_id, status, due_at').in('report_id', ids).eq('status', 'open');
    (ds || []).forEach(d => { disputes[d.report_id] = d; });
  }
  return { aboutMe, viewers, disputes, aboutFiles, DISPUTABLE: D.DISPUTABLE, CATEGORIES, PURPOSES, fmtDay: N.fmtDay, fmtSize, CFPB_SUMMARY_URL };
}

module.exports = { loadMyRecord, recordOnReportsTab };
