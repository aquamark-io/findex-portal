// Server-side only. The service-role key bypasses RLS and must never reach the browser.
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'http://localhost',
  process.env.SUPABASE_SERVICE_KEY || 'missing',
  { auth: { persistSession: false, autoRefreshToken: false } }
);

module.exports = supabase;
