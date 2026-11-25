/**
 * Default-search API: access requested by the company and approved by an admin, keys created by the company,
 * lookups by EIN or name + state, logging, and privacy.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, daysAgo } = require('./helpers');
const DEFAULT_DATE = daysAgo(30);

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
  const r = await lender.req('/reports/new/merchant', {
    subject_name: 'Joe’s Cafe LLC', subject_ein: '12-3456789', subject_state: 'TX', subject_contact: 'Joe', subject_email: 'joe@joescafe.com',
    category: 'default', incident_date: DEFAULT_DATE, description: 'Missed payments.', certify: 'on',
  }, { files: { evidence: [{ name: 'a.pdf' }], default_notice: [{ name: 'n.pdf' }] } });
  assert.equal(r.status, 303);
  const rep = fake.tables.fx_reports.at(-1);
  await admin.req(`/admin/reports/${rep.id}/accept`, { note: '' });
  rep.publish_at = new Date(Date.now() - 1000).toISOString();
  assert.equal(await N.publishDue(), 1);
});

async function grantAccess(browser, email) {
  const acct = ctx.accountByEmail(email);
  await browser.req('/api-access/request', { use_note: 'Underwriting checks' });
  await admin.req(`/admin/api/${acct.id}/approve`, {});
  const page = await browser.req('/api-access/keys', { label: 'Production' });
  return page.text.match(/fdx_[A-Za-z0-9_-]{40}/)[0];
}

test('a company requests API access, the admin approves, and the company creates its own key', async () => {
  const acct = ctx.accountByEmail('sam@bestcapital.com');
  const page = await other.req('/api-access');
  assert.equal(page.status, 200);
  assert.match(page.text, /Request API access/);
  // No keys before approval.
  await other.req('/api-access/keys', { label: 'Early' });
  assert.equal((fake.tables.fx_api_keys || []).filter(k => k.account_id === acct.id).length, 0);

  const r = await other.req('/api-access/request', { use_note: 'Check new applications' });
  assert.equal(r.status, 303);
  assert.equal(fake.tables.fx_api_access.find(x => x.account_id === acct.id).status, 'requested');
  const note = ctx.lastEmail(process.env.ONBOARDING_NOTIFY_EMAIL, 'fx-admin-api-request');
  assert.ok(note, 'admin is notified');
  assert.match(note.text, /Best Capital Inc/);
  assert.match(note.text, /Check new applications/);
  assert.match((await other.req('/dashboard')).text, /Requested\. We/);

  const queue = await admin.req('/admin/api');
  assert.match(queue.text, /Best Capital Inc/);
  assert.match(queue.text, /Check new applications/);
  const ok = await admin.req(`/admin/api/${acct.id}/approve`, {});
  assert.equal(ok.status, 303);
  assert.ok(ctx.lastEmail('sam@bestcapital.com', 'fx-api-approved'), 'the company is emailed');
  assert.match((await other.req('/dashboard')).text, /Manage API keys/);

  const created = await other.req('/api-access/keys', { label: 'Production' });
  assert.equal(created.status, 200);
  key = (created.text.match(/fdx_[A-Za-z0-9_-]{40}/) || [])[0];
  assert.ok(key, 'the new key is shown to the company');
  const row = fake.tables.fx_api_keys.at(-1);
  keyId = row.id;
  assert.equal(row.account_id, acct.id);
  assert.ok(!JSON.stringify(row).includes(key), 'the key itself is not stored');
  assert.ok(!(await other.req('/api-access')).text.includes(key), 'shown only once');
  const adminPage = await admin.req(`/admin/accounts/${acct.id}`);
  assert.ok(!adminPage.text.includes(key), 'FinDex admins never see the key');
  assert.match(adminPage.text, new RegExp(row.key_prefix));
});

test('requests without a valid key are refused', async () => {
  assert.equal((await api('/api/v1/merchant', { ein: '12-3456789' })).status, 401);
  assert.equal((await api('/api/v1/merchant', { ein: '12-3456789' }, { auth: `fdx_${'x'.repeat(40)}` })).body.error.code, 'invalid_key');
});

test('lookup by EIN returns the published default, the reporter, and logs the search without the EIN', async () => {
  const r = await api('/api/v1/merchant', { ein: '12-3456789' }, { auth: key });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.checks.default.on_record, true);
  assert.deepEqual(r.body.searched_by, ['ein']);
  assert.deepEqual(r.body.checks.default.reports[0].matched_on, ['ein']);
  assert.equal(r.body.checks.default.reports.length, 1);
  assert.equal(r.body.checks.default.reports[0].incident_date, DEFAULT_DATE);
  assert.equal(r.body.checks.default.reports[0].reported_by, 'Acme Funding LLC');
  assert.deepEqual(r.body.checks.document_tampering, { on_record: false, reports: [] });
  assert.ok(!('description' in r.body.checks.default.reports[0]), 'descriptions stay in the portal');
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
  const r = await api('/api/v1/merchant', { name: 'joes cafe', state: 'tx' }, { auth: key });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.searched_by, ['name_state']);
  assert.equal(r.body.checks.default.on_record, true);
});

test('send what you have: EIN plus name and state in one call, each report says what it matched on', async () => {
  const both = await api('/api/v1/merchant', { ein: '12-3456789', name: 'Joe’s Cafe, LLC', state: 'TX', checks: ['default'] }, { auth: key });
  assert.equal(both.status, 200);
  assert.deepEqual(both.body.searched_by, ['ein', 'name_state']);
  assert.deepEqual(both.body.checks.default.reports[0].matched_on, ['ein', 'name_state']);
  // A wrong EIN still finds the business by name and state, and says so.
  const nameOnly = await api('/api/v1/merchant', { ein: '99-9999999', name: 'Joes Cafe', state: 'TX', checks: ['default'] }, { auth: key });
  assert.equal(nameOnly.body.checks.default.on_record, true);
  assert.deepEqual(nameOnly.body.checks.default.reports[0].matched_on, ['name_state']);
  // A name without its state is not enough on its own.
  const noState = await api('/api/v1/merchant', { name: 'Joes Cafe' }, { auth: key });
  assert.equal(noState.status, 422);
  assert.match(noState.body.error.message, /state/);
});

test('no match, invalid input, and bad JSON', async () => {
  const none = await api('/api/v1/merchant', { ein: '98-7654321' }, { auth: key });
  assert.equal(none.status, 200);
  assert.equal(none.body.checks.default.on_record, false);
  assert.deepEqual(none.body.checks.default.reports, []);
  const bad = await api('/api/v1/merchant', { ein: '123' }, { auth: key });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error.message, /EIN must be 9 digits/);
  assert.equal((await api('/api/v1/merchant', {}, { auth: key })).status, 422);
  assert.equal((await api('/api/v1/merchant', null, { auth: key, raw: '{not json' })).body.error.code, 'invalid_json');
});

test('checks are modular: defaults, document tampering, or both; results_url shows only what was asked', async () => {
  await lender.req('/reports/new/merchant', {
    subject_name: 'Joe’s Cafe LLC', subject_ein: '12-3456789', subject_state: 'TX', subject_contact: 'Joe', subject_email: 'joe@joescafe.com',
    category: 'fraud', incident_date: '2026-08-01', description: 'Altered bank statements.', certify: 'on',
  }, { files: { evidence: [{ name: 'statements.pdf' }] } });
  const rep = fake.tables.fx_reports.at(-1);
  assert.equal(rep.category, 'fraud');
  await admin.req(`/admin/reports/${rep.id}/accept`, { note: '' });
  rep.publish_at = new Date(Date.now() - 1000).toISOString();
  await N.publishDue();

  const both = await api('/api/v1/merchant', { ein: '12-3456789' }, { auth: key });
  assert.deepEqual(Object.keys(both.body.checks).sort(), ['default', 'document_tampering']);
  assert.equal(both.body.checks.document_tampering.on_record, true);
  assert.equal(both.body.checks.document_tampering.reports[0].incident_date, '2026-08-01');

  const defOnly = await api('/api/v1/merchant', { ein: '12-3456789', checks: ['default'] }, { auth: key });
  assert.deepEqual(Object.keys(defOnly.body.checks), ['default']);
  const page = await other.req(new URL(defOnly.body.results_url).pathname);
  assert.match(page.text, /Default/);
  assert.doesNotMatch(page.text, /Altered bank statements/, 'the portal link shows only the checks requested');

  const tamper = await api('/api/v1/merchant', { ein: '12-3456789', checks: 'document_tampering' }, { auth: key });
  assert.deepEqual(Object.keys(tamper.body.checks), ['document_tampering']);
  assert.match((await other.req(new URL(tamper.body.results_url).pathname)).text, /Altered bank statements/);

  // There is one endpoint: the old /defaults and /funded-business addresses are gone.
  for (const old of ['/api/v1/defaults', '/api/v1/funded-business']) {
    const gone = await api(old, { ein: '12-3456789' }, { auth: key });
    assert.equal(gone.status, 404);
    assert.equal(gone.body.error.code, 'not_found');
  }

  const bad = await api('/api/v1/merchant', { ein: '12-3456789', checks: ['fraud'] }, { auth: key });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error.message, /document_tampering/);
});

test('reports still in their notice period are not returned', async () => {
  await lender.req('/reports/new/merchant', {
    subject_name: 'Pending Co LLC', subject_ein: '55-5555555', subject_state: 'CA', subject_contact: 'P', subject_email: 'p@pending.co',
    category: 'default', incident_date: DEFAULT_DATE, description: 'x', certify: 'on',
  }, { files: { evidence: [{ name: 'a.pdf' }], default_notice: [{ name: 'n.pdf' }] } });
  await admin.req(`/admin/reports/${fake.tables.fx_reports.at(-1).id}/accept`, { note: '' });
  const r = await api('/api/v1/merchant', { ein: '55-5555555' }, { auth: key });
  assert.equal(r.body.checks.default.on_record, false);
});

test('recent searches by other companies are counted', async () => {
  await lender.req('/search/merchant', { ein: '12-3456789', certify: 'on' });
  const r = await api('/api/v1/merchant', { ein: '12-3456789' }, { auth: key });
  assert.equal(r.body.recent_searches.companies, 1);
});

test('a company can revoke its own key, and it stops working immediately', async () => {
  const rv = await other.req(`/api-access/keys/${keyId}/revoke`, {});
  assert.equal(rv.status, 303);
  assert.ok(fake.tables.fx_api_keys.find(k => k.id === keyId).revoked_at);
  assert.equal((await api('/api/v1/merchant', { ein: '12-3456789' }, { auth: key })).status, 401);
});

test('turning off API access revokes every key; the company can ask again', async () => {
  const acct = ctx.accountByEmail('sam@bestcapital.com');
  const k1 = (await other.req('/api-access/keys', { label: 'A' })).text.match(/fdx_[A-Za-z0-9_-]{40}/)[0];
  const k2 = (await other.req('/api-access/keys', { label: 'B' })).text.match(/fdx_[A-Za-z0-9_-]{40}/)[0];
  assert.equal((await api('/api/v1/merchant', { ein: '12-3456789' }, { auth: k1 })).status, 200);
  await admin.req(`/admin/api/${acct.id}/revoke`, { back: 'account' });
  assert.ok(ctx.lastEmail('sam@bestcapital.com', 'fx-api-revoked'));
  for (const k of [k1, k2]) assert.equal((await api('/api/v1/merchant', { ein: '12-3456789' }, { auth: k })).status, 401);
  assert.match((await other.req('/api-access')).text, /turned off/);
  await other.req('/api-access/request', {});
  assert.equal(fake.tables.fx_api_access.find(x => x.account_id === acct.id).status, 'requested');
  await admin.req(`/admin/api/${acct.id}/deny`, {});
  assert.ok(ctx.lastEmail('sam@bestcapital.com', 'fx-api-denied'));
  assert.equal((await other.req('/api-access/keys', { label: 'C' })).status, 303, 'no keys while denied');
});

test('keys stop working when the company loses FinDex access; accounts without full access cannot request', async () => {
  const k2 = await grantAccess(lender, 'pat@acmefunding.com');
  assert.equal((await api('/api/v1/merchant', { ein: '12-3456789' }, { auth: k2 })).status, 200);
  const acct = ctx.accountByEmail('pat@acmefunding.com');
  await admin.req(`/admin/accounts/${acct.id}/deny`, { note: '' });
  assert.equal((await api('/api/v1/merchant', { ein: '12-3456789' }, { auth: k2 })).status, 401);
  // A company without the member terms (Check My Record sign-up) is sent back to its dashboard.
  acct.status = 'approved'; acct.terms_version = null;
  const b = await ctx.signIn(ctx.browser(), 'pat@acmefunding.com');
  const r = await b.req('/api-access');
  assert.equal(r.location, '/dashboard');
});

test('a company can have at most 5 active keys', async () => {
  const acct = ctx.accountByEmail('sam@bestcapital.com');
  await other.req('/api-access/request', {});
  await admin.req(`/admin/api/${acct.id}/approve`, {});
  for (let i = 0; i < 5; i++) assert.equal((await other.req('/api-access/keys', { label: `K${i}` })).status, 200);
  const r = await other.req('/api-access/keys', { label: 'Too many' });
  assert.equal(r.status, 422);
  assert.match(r.text, /up to 5 active keys/);
});

test('/api sends people to the documentation on joinfindex.com', async () => {
  const r = await ctx.browser().req('/api');
  assert.equal(r.status, 301);
  assert.match(r.location, /^https:\/\/joinfindex\.com\/api\/$/);
});
