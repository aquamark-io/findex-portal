// Server-side only. The service-role key bypasses RLS and must never reach the browser.
// Exported through a thin proxy so tests can swap in an in-memory stand-in with supabase.set(fake).
const { createClient } = require('@supabase/supabase-js');

let client = createClient(
  process.env.SUPABASE_URL || 'http://localhost',
  process.env.SUPABASE_SERVICE_KEY || 'missing',
  { auth: { persistSession: false, autoRefreshToken: false } }
);

module.exports = new Proxy({}, {
  get(_, prop) {
    if (prop === 'set') return next => { client = next; };
    const v = client[prop];
    return typeof v === 'function' ? v.bind(client) : v;
  },
});
