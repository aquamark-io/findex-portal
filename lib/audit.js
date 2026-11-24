/**
 * Admin audit log (fx_admin_audit): which admin did what, to what, when, from which IP.
 * Append-only: the database rejects every update and delete. `detail` must never contain DOB, SSN, or EIN.
 *
 * Throws if the entry can't be saved, so an admin action never goes unrecorded silently:
 * file opens and sign-ins are written before they happen; changes are written right after.
 */
const supabase = require('./supabase');

const ACTIONS = {
  admin_login: 'Signed in',
  admin_login_failed: 'Wrong sign-in code or password',
  admin_logout: 'Signed out',
  admin_added: 'Admin added',
  admin_disabled: 'Admin disabled',
  admin_enabled: 'Admin re-enabled',
  admin_renamed: 'Admin renamed',
  account_approved: 'Account approved',
  account_denied: 'Account denied',
  account_revoked: 'Account access revoked',
  test_account_deleted: 'Test account deleted',
  report_accepted: 'Report accepted (notice sent)',
  report_rejected: 'Report rejected',
  test_report_deleted: 'Test report deleted',
  dispute_upheld: 'Dispute decided: upheld (report published)',
  dispute_amended: 'Dispute decided: amended (report published with corrections)',
  dispute_removed: 'Dispute decided: report removed',
  api_access_approved: 'API access approved',
  api_access_denied: 'API access denied',
  api_access_revoked: 'API access turned off',
  api_key_revoked: 'API key revoked',
  evidence_opened: 'Evidence file opened',
  dispute_file_opened: 'Dispute file opened',
  authorization_opened: 'Authorization file opened',
  ai_review_requested: 'AI review requested',
  subject_linked: 'Reported party linked to an account',
  test_email_sent: 'Test email sent',
  test_data_cleared: 'Test data cleared',
  contact_opened: 'Contact message opened',
  contact_updated: 'Contact message updated',
};

const TARGET_TYPES = { account: 'Account', report: 'Report', admin: 'Admin', api_key: 'API key', file: 'File', contact: 'Contact message' };

async function logAdmin(req, action, { targetType = null, targetId = null, detail = {} } = {}, adminOverride) {
  const admin = adminOverride || req.admin;
  if (!admin) throw new Error('Audit log: no admin');
  const { error } = await supabase.from('fx_admin_audit').insert({
    admin_id: admin.id || null,
    admin_name: admin.name,
    admin_email: admin.email || null,
    action,
    target_type: targetType,
    target_id: targetId == null ? null : String(targetId),
    detail,
    ip: req.ip || null,
  });
  if (error) throw new Error(`Audit log (${action}): ${error.message}`);
}

module.exports = { logAdmin, ACTIONS, TARGET_TYPES };
