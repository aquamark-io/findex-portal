// Audit log. `detail` must never contain DOB, SSN, or EIN.
const supabase = require('./supabase');

async function logEvent({ accountId = null, event, actor, detail = {}, ip = null }) {
  const { error } = await supabase.from('fx_events').insert({ account_id: accountId, event, actor, detail, ip });
  if (error) console.error(`fx_events insert failed (${event}):`, error.message);
}

module.exports = { logEvent };
