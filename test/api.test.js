/**
 * Default-search API: keys issued and revoked by an admin, lookups by EIN or name + state, logging, and privacy.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

const ctx = setup();
const N = require('../lib/notices');
const { fake } = ctx;

test.before(ctx.start);
test.after(ctx.stop);

let admin, lender, other, key, keyId;
const ip = '10.9.9.9';

function api(path, body, { auth, raw } = {}) {
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return ctx.realFetch(ctx.base + path, { method: 'POST', headers, body: raw ?? JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() }));
}

test('setup: a lender reports a default that gets published', async () => {
  admin = await ctx.admin();
  lender = await ctx.member(admin, { email: 'pat@acmefunding.com', domain: 'acmefunding.com', companyType: 'funder' });
  other = await ctx.member(admin, { email: 'sam@bestcapital.com', domain: 'bestcapital.com', company: 'Best Capital Inc', companyType: 'lender' });
  const r = await lender.req('/reports/new/funded-business', {
    subject_name: 'Joe’s Cafe LLC', subject_ein: '12-3456789', subject_state: 'TX', subject_contact: 'Joe', subject_email: 'joe@joescafe.com',
    category: 'default', incident_date: '2026-09-15', description: 'Missed payments.', certify: 'on',
  }, { files: { evidence: [{ name: 'a.pdf' }], default_notice: [{ name: 'n.pdf' }] } });
  assert.equal(r.status, 303);
  const rep = fake.tables.fx_reports.at(-1);
  await admin.req(`/admin/reports/${rep.id}/accept`, { note: '' });
  rep.publish_at = new Date(Date.now() - 1000).toISOString();
  assert.equal(await N.publishDue(), 1);
});

test('an admin issues a key; it is shown once and only its hash is stored', async () => {
  const acct = ctx.accountByEmail('sam@bestcapital.com');
  const page = await admin.req(`/admin/accounts/${acct.id}/api-keys`, { label: 'Production' });
  assert.equal(page.status, 200);
  key = (page.text.match(/fdx_[A-Za-z0-9_-]{40}/) || [])[0];
  assert.ok(key, 'the new key is on the page');
  const row = fake.tables.fx_api_keys.at(-1);
  keyId = row.id;
  assert.equal(row.account_id, acct.id);
  assert.equal(row.label, 'Production');
  assert.ok(!JSON.stringify(row).includes(key), 'the key itself is not stored');
  assert.equal(row.key_prefix, key.slice(0, 10));
  const again = await admin.req(`/admin/accounts/${acct.id}`);
  assert.ok(!again.text.includes(key), 'not shown again');
  assert.match(again.text, new RegExp(`${row.key_prefix}`));
});

test('requests without a valid key are refused', async () => {
  assert.equal((await api('/api/v1/defaults', { ein: '12-3456789' })).status, 401);
  assert.equal((await api('/api/v1/defaults', { ein: '12-3456789' }, { auth: `fdx_${'x'.repeat(40)}` })).body.error.code, 'invalid_key');
});

test('lookup by EIN returns the published default, the reporter, and logs the search without the EIN', async () => {
  const r = await api('/api/v1/defaults', { ein: '12-3456789' }, { auth: key });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.has_default, true);
  assert.equal(r.body.searched_by, 'ein');
  assert.equal(r.body.defaults.length, 1);
  assert.equal(r.body.defaults[0].incident_date, '2026-09-15');
  assert.equal(r.body.defaults[0].reported_by, 'Acme Funding LLC');
  assert.equal(r.body.other_reports, 0);
  assert.match(r.body.results_url, /\/search\/results\/[0-9a-f-]{36}$/);
  const log = fake.tables.fx_searches.find(s => s.id === r.body.search_id);
  assert.equal(log.api_key_id, keyId);
  assert.equal(log.account_id, ctx.accountByEmail('sam@bestcapital.com').id);
  assert.equal(log.criteria.via, 'api');
  assert.ok(!JSON.stringify(log).includes('123456789'), 'EIN not stored');
  assert.ok(fake.tables.fx_api_keys.find(k => k.id === keyId).last_used_at);
  // The member can open the full results in the portal.
  const page = await other.req(new URL(r.body.results_url).pathname);
  assert.equal(page.status, 200);
  assert.match(page.text, /Default/);
});

test('lookup by legal name and state works, ignoring punctuation and LLC', async () => {
  const r = await api('/api/v1/defaults', { name: 'joes cafe', state: 'tx' }, { auth: key });
  assert.equal(r.status, 200);
  assert.equal(r.body.searched_by, 'name_state');
  assert.equal(r.body.has_default, true);
});

test('no match, invalid input, and bad JSON', async () => {
  const none = await api('/api/v1/defaults', { ein: '98-7654321' }, { auth: key });
  assert.equal(none.status, 200);
  assert.equal(none.body.has_default, false);
  assert.deepEqual(none.body.defaults, []);
  const bad = await api('/api/v1/defaults', { ein: '123' }, { auth: key });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error.message, /EIN must be 9 digits/);
  assert.equal((await api('/api/v1/defaults', {}, { auth: key })).status, 422);
  assert.equal((await api('/api/v1/defaults', null, { auth: key, raw: '{not json' })).body.error.code, 'invalid_json');
});

test('reports still in their notice period are not returned', async () => {
  await lender.req('/reports/new/funded-business', {
    subject_name: 'Pending Co LLC', subject_ein: '55-5555555', subject_state: 'CA', subject_contact: 'P', subject_email: 'p@pending.co',
    category: 'default', incident_date: '2026-10-01', description: 'x', certify: 'on',
  }, { files: { evidence: [{ name: 'a.pdf' }], default_notice: [{ name: 'n.pdf' }] } });
  await admin.req(`/admin/reports/${fake.tables.fx_reports.at(-1).id}/accept`, { note: '' });
  const r = await api('/api/v1/defaults', { ein: '55-5555555' }, { auth: key });
  assert.equal(r.body.has_default, false);
});

test('recent searches by other companies are counted', async () => {
  await lender.req('/search/funded-business', { ein: '12-3456789', certify: 'on' });
  const r = await api('/api/v1/defaults', { ein: '12-3456789' }, { auth: key });
  assert.equal(r.body.recent_searches.companies, 1);
});

test('a revoked key stops working immediately', async () => {
  const acct = ctx.accountByEmail('sam@bestcapital.com');
  const rv = await admin.req(`/admin/accounts/${acct.id}/api-keys/${keyId}/revoke`, {});
  assert.equal(rv.status, 303);
  assert.ok(fake.tables.fx_api_keys.find(k => k.id === keyId).revoked_at);
  assert.equal((await api('/api/v1/defaults', { ein: '12-3456789' }, { auth: key })).status, 401);
});

test('keys stop working when the company loses access, and are not issued to pending accounts', async () => {
  const acct = ctx.accountByEmail('pat@acmefunding.com');
  const page = await admin.req(`/admin/accounts/${acct.id}/api-keys`, { label: 'Test' });
  const k2 = page.text.match(/fdx_[A-Za-z0-9_-]{40}/)[0];
  assert.equal((await api('/api/v1/defaults', { ein: '12-3456789' }, { auth: k2 })).status, 200);
  await admin.req(`/admin/accounts/${acct.id}/deny`, { note: '' });
  assert.equal((await api('/api/v1/defaults', { ein: '12-3456789' }, { auth: k2 })).status, 401);
  const r = await admin.req(`/admin/accounts/${acct.id}/api-keys`, { label: 'Nope' });
  assert.equal(r.status, 303);
  assert.match(new URL(r.location, ctx.base).searchParams.get('err'), /only for approved companies/);
});

test('the documentation page is public', async () => {
  const b = ctx.browser();
  const r = await b.req('/api');
  assert.equal(r.status, 200);
  assert.match(r.text, /Default Search API/);
  assert.match(r.text, /\/api\/v1\/defaults/);
});
