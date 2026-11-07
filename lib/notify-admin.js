/**
 * Activity emails to the admin (ONBOARDING_NOTIFY_EMAIL) for sign-ins and sign-in attempts.
 * On by default; set ADMIN_ACTIVITY_EMAILS=false in Render to turn them off.
 * Skipped for [TEST] accounts. Failures are logged, never shown to the user.
 */
const { sendEmail, templates } = require('./email');

const enabled = () => String(process.env.ADMIN_ACTIVITY_EMAILS || 'true').toLowerCase() !== 'false';

async function notifyAdminActivity(kind, { email, account = null }) {
  if (!enabled() || !process.env.ONBOARDING_NOTIFY_EMAIL) return;
  if (account && account.is_test) return;
  try {
    await sendEmail({ to: process.env.ONBOARDING_NOTIFY_EMAIL, tag: `fx-admin-activity-${kind}`, ...templates.adminActivity(kind, { email, account }) });
  } catch (err) {
    console.error(`Admin activity email (${kind}) failed:`, err.message);
  }
}

module.exports = { notifyAdminActivity };
