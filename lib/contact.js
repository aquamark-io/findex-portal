/**
 * Contact form messages (fx_contact_requests). Each gets a reference like FX-7F3A21, a confirmation email to the
 * sender, and an alert to ONBOARDING_NOTIFY_EMAIL with the topic and reference only (never the message text).
 */
const supabase = require('./supabase');
const { sendEmail, templates } = require('./email');
const { logEvent } = require('./events');

const TOPICS = {
  account_access: 'Signing in or account access',
  access_request: 'My access request',
  report_about_me: 'A report about me or a dispute',
  report_i_submitted: 'A report I submitted',
  search_api: 'Search or API',
  my_information: 'Correcting or deleting my information',
  other: 'Something else',
};
const STATUSES = { open: 'Open', in_progress: 'In progress', closed: 'Closed' };

const referenceOf = id => `FX-${String(id).replace(/-/g, '').slice(0, 6).toUpperCase()}`;

async function send(job, what) {
  try { await sendEmail(job); return true; } catch (err) { console.error(`${what} failed:`, err.message); return false; }
}

async function createRequest({ accountId = null, name = null, email, topic, message, ip = null }) {
  const { data: row, error } = await supabase.from('fx_contact_requests')
    .insert({ account_id: accountId, name: name || null, contact_email: email, topic, message, ip })
    .select('id').single();
  if (error) throw new Error(`Contact request: ${error.message}`);
  const reference = referenceOf(row.id);
  const info = { reference, topic: TOPICS[topic], name };
  await Promise.all([
    send({ to: email, tag: 'fx-contact-received', ...templates.contactReceived(info) }, 'Contact confirmation'),
    process.env.ONBOARDING_NOTIFY_EMAIL
      ? send({ to: process.env.ONBOARDING_NOTIFY_EMAIL, tag: 'fx-admin-contact', ...templates.adminContactAlert({ ...info, id: row.id }) }, 'Contact alert')
      : null,
  ]);
  if (accountId) await logEvent({ accountId, event: 'contact_sent', actor: 'account', detail: { topic, reference }, ip });
  return { id: row.id, reference };
}

module.exports = { TOPICS, STATUSES, referenceOf, createRequest };
