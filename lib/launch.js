/**
 * Launch checklist: each check returns { key, label, ok, detail }. Render settings are checked by name only;
 * values are never read into the page.
 */
const supabase = require('./supabase');
const turnstile = require('./turnstile');
const { MEMBER_TERMS_VERSION } = require('./terms');

const REQUIRED_SETTINGS = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'POSTMARK_SERVER_TOKEN', 'POSTMARK_WEBHOOK_TOKEN', 'ONBOARDING_FROM_EMAIL',
  'ONBOARDING_NOTIFY_EMAIL', 'JWT_SECRET', 'FIELD_ENCRYPTION_KEY', 'FIELD_HASH_KEY', 'PORTAL_BASE_URL', 'ADMIN_OWNER_EMAIL',
];

const isSet = name => Boolean(process.env[name] && String(process.env[name]).trim());

function pacificNow(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function settingsCheck() {
  const missing = REQUIRED_SETTINGS.filter(n => !isSet(n));
  return { key: 'settings', label: 'Required Render settings are present', ok: !missing.length,
    detail: missing.length ? `Missing: ${missing.join(', ')}` : `All ${REQUIRED_SETTINGS.length} are set: ${REQUIRED_SETTINGS.join(', ')}` };
}

function productionCheck() {
  const ok = process.env.NODE_ENV === 'production';
  return { key: 'production', label: 'Running in production mode', ok, detail: ok ? 'NODE_ENV is production.' : 'Set NODE_ENV to production in Render.' };
}

async function postmarkCheck(fetchImpl = fetch) {
  const label = 'Postmark is sending';
  if (!isSet('POSTMARK_SERVER_TOKEN')) return { key: 'postmark', label, ok: false, detail: 'POSTMARK_SERVER_TOKEN is not set.' };
  try {
    const res = await fetchImpl('https://api.postmarkapp.com/server', {
      headers: { Accept: 'application/json', 'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { key: 'postmark', label, ok: false, detail: `Postmark rejected the server token (HTTP ${res.status}).` };
    return { key: 'postmark', label, ok: true, detail: 'Postmark accepted the server token. Use "Send a test email" below to confirm delivery.' };
  } catch (err) {
    return { key: 'postmark', label, ok: false, detail: 'Could not reach Postmark.' };
  }
}

async function dailyJobCheck(now = new Date()) {
  const label = 'The daily job is running';
  if (process.env.DISABLE_DAILY_JOB === 'true') return { key: 'daily_job', label, ok: false, detail: 'DISABLE_DAILY_JOB is true in Render.' };
  const { data, error } = await supabase.from('fx_events').select('detail, created_at').eq('event', 'daily_job')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Daily job check: ${error.message}`);
  if (!data) return { key: 'daily_job', label, ok: false, detail: 'The daily job has never run.' };
  const { day, hour } = pacificNow(now);
  const yesterday = pacificNow(new Date(now.getTime() - 24 * 3600 * 1000)).day;
  const last = data.detail && data.detail.day;
  const ok = last === day || (hour < 6 && last === yesterday);
  return { key: 'daily_job', label, ok, detail: ok ? `Last ran ${last} (it runs after 6 AM Pacific).` : `Last ran ${last || 'unknown'}; it should run every day after 6 AM Pacific.` };
}

// Test records, plus the two kinds of pre-launch record the current matching can't find.
async function testDataCounts() {
  const head = table => supabase.from(table).select('id', { count: 'exact', head: true });
  const n = async q => { const { count, error } = await q; if (error) throw new Error(`Test data count: ${error.message}`); return count || 0; };
  return {
    testAccounts: await n(head('fx_accounts').eq('is_test', true)),
    testReports: await n(head('fx_reports').eq('is_test', true)),
    oldPersonKeys: await n(head('fx_subjects').eq('subject_type', 'individual').not('identity_hash', 'ilike', 'person:v2:%')),
    businessesNoNameKey: await n(head('fx_subjects').eq('subject_type', 'merchant').is('biz_key', null)),
  };
}

async function testDataCheck() {
  const c = await testDataCounts();
  const items = [
    c.testAccounts && `${c.testAccounts} test account${c.testAccounts === 1 ? '' : 's'}`,
    c.testReports && `${c.testReports} test report${c.testReports === 1 ? '' : 's'}`,
    c.oldPersonKeys && `${c.oldPersonKeys} person record${c.oldPersonKeys === 1 ? '' : 's'} with an old SSN-based key (no longer findable)`,
    c.businessesNoNameKey && `${c.businessesNoNameKey} business record${c.businessesNoNameKey === 1 ? '' : 's'} with no name + state key`,
  ].filter(Boolean);
  return { key: 'test_data', label: 'Test accounts and reports are removed', ok: !items.length, counts: c,
    detail: items.length ? `Still present: ${items.join('; ')}.` : 'No test or old-format records.' };
}

function legalCheck() {
  const v = MEMBER_TERMS_VERSION || '';
  const ok = Boolean(v) && !/draft/i.test(v);
  return { key: 'legal', label: 'Legal versions are set', ok,
    detail: ok ? `Member terms version ${v}.` : `Member terms version is "${v || 'not set'}". Replace the draft with counsel's text and set a final version in lib/terms.js.` };
}

function turnstileCheck() {
  const ok = turnstile.enabled();
  return { key: 'turnstile', label: 'Turnstile is on', ok,
    detail: ok ? 'TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set.' : 'Set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY in Render.' };
}

async function runChecks() {
  return [
    settingsCheck(), productionCheck(), await postmarkCheck(), await dailyJobCheck(),
    await testDataCheck(), legalCheck(), turnstileCheck(),
  ];
}

module.exports = { runChecks, REQUIRED_SETTINGS, testDataCounts, pacificNow, dailyJobCheck };
