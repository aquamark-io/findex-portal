/**
 * Admin notification settings.
 * The admin (ONBOARDING_NOTIFY_EMAIL) is emailed only for: new access requests, new reports, new disputes,
 * and changes a customer makes to a report or dispute (dispute response, report removed, payment status
 * updated, new notice email). Sign-ins, sign-in attempts, duplicate sign-ups, full-access upgrades,
 * bounced notices and dispute due-date reminders are not emailed (they are still logged in fx_events
 * or shown in the admin queues).
 */

// [TEST] requests/accounts email the admin too, so the whole workflow can be seen while testing.
// Set TEST_NOTIFICATIONS=false in Render to keep [TEST] activity silent.
const testNotificationsOn = () => String(process.env.TEST_NOTIFICATIONS || 'true').toLowerCase() !== 'false';

module.exports = { testNotificationsOn };
