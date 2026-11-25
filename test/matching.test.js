/**
 * Matching without SSN, business search by EIN or legal name + state, and recent search counts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, daysAgo } = require('./helpers');
const DEFAULT_DATE = daysAgo(30);

const ctx = setup();
const N = require('../lib/notices');
const ID = require('../lib/identity');
const { fake, emails } = ctx;

test.before(ctx.start);
test.after(ctx.stop);

let admin, lender, b2, b3, b4;

async function publishLatest() {
  const rep = fake.tables.fx_reports.at(-1);
  await admin.req(`/admin/reports/${rep.id}/accept`, { note: '' });
  rep.publish_at = new Date(Date.now() - 1000).toISOString();
  await N.publishDue();
  assert.equal(rep.status, 'published');
  return rep;
}
async function search(b, who, form) {
  const r = await b.req(`/search/${who}`, { certify: 'on', ...form });
  if (r.status !== 303) return r;
  return b.req(r.location);
}

test('setup: four member companies', async () => {
  admin = await ctx.admin();
  lender = await ctx.member(admin, { email: 'pat@acmefunding.com', domain: 'acmefunding.com', companyType: 'funder' });
  b2 = await ctx.member(admin, { email: 'a@two.com', domain: 'two.com', company: 'Two Capital', companyType: 'lender' });
  b3 = await ctx.member(admin, { email: 'a@three.com', domain: 'three.com', company: 'Three Capital', companyType: 'lender' });
  b4 = await ctx.member(admin, { email: 'a@four.com', domain: 'four.com', company: 'Four Capital', companyType: 'broker' });
});

// ---------- businesses ----------

test('reporting a business requires the state of registration', async () => {
  const r = await lender.req('/reports/new/funded-business', {
    subject_name: 'Joe’s Cafe, L.L.C.', subject_ein: '12-3456789', subject_contact: 'Joe', subject_email: 'joe@joescafe.com',
    category: 'default', incident_date: DEFAULT_DATE, description: 'x', certify: 'on',
  }, { files: { evidence: [{ name: 'a.pdf' }], default_notice: [{ name: 'n.pdf' }] } });
  assert.equal(r.status, 422);
  assert.match(r.text, /State of registration is required/);
  const ok = await lender.req('/reports/new/funded-business', {
    subject_name: 'Joe’s Cafe, L.L.C.', subject_ein: '12-3456789', subject_state: 'TX', subject_contact: 'Joe', subject_email: 'joe@joescafe.com',
    category: 'default', incident_date: DEFAULT_DATE, description: 'x', certify: 'on',
  }, { files: { evidence: [{ name: 'a.pdf' }], default_notice: [{ name: 'n.pdf' }] } });
  assert.equal(ok.status, 303);
  await publishLatest();
  const subj = fake.tables.fx_subjects.find(s => s.subject_type === 'merchant');
  assert.equal(subj.state, 'TX');
  assert.equal(subj.biz_key, ID.bizKey('TX', 'JOES CAFE LLC'), 'name is stored as a normalized one-way key');
});

test('a business can be found by EIN alone', async () => {
  const res = await search(b2, 'funded-business', { ein: '123456789' });
  assert.match(res.text, /1 published report/);
  assert.doesNotMatch(res.text, /Confirm the EIN/, 'an EIN match needs no extra confirmation');
});

test('or by legal name + state, ignoring case, punctuation and LLC / Inc', async () => {
  const res = await search(b3, 'funded-business', { name: 'JOES CAFE LLC', state: 'TX' });
  assert.match(res.text, /1 published report/);
  assert.match(res.text, /Legal name and state/);
  assert.match(res.text, /Confirm the EIN/);
});

test('the same name in another state, or a name without a state, finds nothing', async () => {
  let res = await search(b3, 'funded-business', { name: 'Joes Cafe', state: 'CA' });
  assert.match(res.text, /No published reports found/);
  res = await search(b3, 'funded-business', { name: 'Joes Cafe' });
  assert.equal(res.status, 422);
  assert.match(res.text, /state where the business is registered/);
  res = await search(b3, 'funded-business', {});
  assert.match(res.text, /Enter the EIN, or the business legal name and state/);
});

test('results show how many other companies searched the business in the last 30 days', async () => {
  // So far: b2 (EIN) and b3 (name + state) searched Joe's Cafe. b3 also searched the CA name, which isn't this business.
  const res = await search(b4, 'funded-business', { ein: '12-3456789' });
  assert.match(res.text, /<span class="biz-num">2<\/span><span>Searches by other companies in the last 30 days \(2 companies\)/);
  assert.match(res.text, /<span class="biz-num">1<\/span><span>Default reported/);
  // The searcher's own searches don't count, and searches over 30 days old drop off.
  const again = await search(b4, 'funded-business', { name: 'Joe’s Cafe LLC', state: 'TX' });
  assert.match(again.text, /<span class="biz-num">2<\/span><span>Searches by other/);
  const old = fake.tables.fx_searches.find(s => s.account_id === ctx.accountByEmail('a@two.com').id);
  old.created_at = new Date(Date.now() - 31 * 864e5).toISOString();
  const later = await search(b4, 'funded-business', { ein: '12-3456789' });
  assert.match(later.text, /<span class="biz-num">1<\/span><span>Searches by other companies in the last 30 days \(1 company\)/);
});

test('the count works for a business with no reports, and the EIN is never stored', async () => {
  await search(b2, 'funded-business', { ein: '55-5555555' });
  const res = await search(b3, 'funded-business', { ein: '55-5555555' });
  assert.match(res.text, /No published reports found/);
  assert.match(res.text, /<span class="biz-num">1<\/span><span>Searches by other companies/);
  assert.ok(!JSON.stringify(fake.tables.fx_searches).includes('555555555'));
});

// ---------- people (no SSN) ----------

const person = { subject_first_name: 'Jordan', subject_last_name: 'Rivera', subject_dob: '1990-04-12', subject_email: 'jordan@mail.com', subject_phone: '(415) 555-0199', subject_zip: '94105' };

test('reporting a person asks for name, DOB, email, optional mobile and ZIP, and no SSN', async () => {
  const form = await lender.req('/reports/new/individual');
  assert.doesNotMatch(form.text, /SSN/);
  assert.match(form.text, /Mobile/);
  const r = await lender.req('/reports/new/individual', { ...person, category: 'fraud', incident_date: '2026-08-01', description: 'Altered bank statements.', certify: 'on' },
    { files: { evidence: [{ name: 'statements.pdf' }] } });
  assert.equal(r.status, 303, r.text.slice(0, 400));
  await publishLatest();
  const subj = fake.tables.fx_subjects.find(s => s.subject_type === 'individual');
  assert.equal(subj.name, 'Jordan Rivera');
  assert.equal(subj.zip5, '94105');
  assert.equal(subj.identity_hash, ID.personKey('1990-04-12', 'Rivera'));
  assert.ok(fake.tables.fx_subject_phones.some(p => p.subject_id === subj.id && p.phone === '+14155550199'));
});

const empForm = (extra) => ({ purpose: 'employment', employment_certify: 'on', first_name: 'Jordan', last_name: 'Rivera', dob: '1990-04-12', ...extra });
async function searchPerson(b, extra) {
  const r = await b.req('/search/individual', { certify: 'on', ...empForm(extra) }, { files: { authorization: [{ name: 'auth.pdf' }] } });
  if (r.status !== 303) return r;
  return b.req(r.location);
}

test('a person is found by DOB + last name + email, and the results show what matched', async () => {
  const res = await searchPerson(b2, { email: 'jordan@mail.com', zip: '94105' });
  assert.match(res.text, /1 published report/);
  assert.match(res.text, /match yes">Date of birth/);
  assert.match(res.text, /match yes">Email/);
  assert.match(res.text, /match no">Mobile/);
  assert.match(res.text, /match yes">ZIP/);
});

test('or by DOB + last name + mobile; the last name ignores case and punctuation', async () => {
  const res = await searchPerson(b2, { last_name: 'RIVERA', phone: '415-555-0199' });
  assert.match(res.text, /1 published report/);
  assert.match(res.text, /match yes">Mobile/);
});

test('a different first name or ZIP still matches, but is flagged for the searcher to confirm', async () => {
  const res = await searchPerson(b2, { first_name: 'Jay', email: 'jordan@mail.com', zip: '10001' });
  assert.match(res.text, /1 published report/);
  assert.match(res.text, /first name differs/);
});

test('name + DOB alone is refused; a wrong email or a different DOB finds nothing', async () => {
  let res = await searchPerson(b2, {});
  assert.equal(res.status, 422);
  assert.match(res.text, /Add an email or mobile number/);
  res = await searchPerson(b2, { email: 'someone@else.com' });
  assert.match(res.text, /No published reports found/);
  res = await searchPerson(b2, { dob: '1990-04-13', email: 'jordan@mail.com' });
  assert.match(res.text, /No published reports found/);
});

test('a different person with the same name and DOB is kept separate', async () => {
  const r = await lender.req('/reports/new/individual', { ...person, subject_email: 'other.jordan@mail.com', subject_phone: '', subject_zip: '',
    category: 'fraud', incident_date: '2026-07-01', description: 'x', certify: 'on' }, { files: { evidence: [{ name: 'e.pdf' }] } });
  assert.equal(r.status, 303);
  assert.equal(fake.tables.fx_subjects.filter(s => s.subject_type === 'individual').length, 2);
});

// ---------- sign-up and storage ----------

test('people sign up to check their record without an SSN, and are linked to reports about them', async () => {
  const b = ctx.browser();
  const form = await b.req('/check-my-record/individual');
  assert.doesNotMatch(form.text, /SSN/);
  const r = await b.req('/request-access', { account_type: 'individual', mode: 'record', first_name: 'Jordan', last_name: 'Rivera',
    email: 'jordan@mail.com', phone: '(415) 555-0199', current_company: 'Acme', worker_type: 'contractor', job_title: 'ISO rep', dob: '1990-04-12', attest: 'on' });
  assert.equal(r.location, '/request-access/received', r.text.slice(0, 300));
  const acct = ctx.accountByEmail('jordan@mail.com');
  assert.equal(acct.identity_method, 'dob');
  await admin.req(`/admin/accounts/${acct.id}/approve`, { note: '' });
  await ctx.signIn(b, 'jordan@mail.com');
  const dash = await b.req('/dashboard'); // reports are linked when the dashboard opens
  assert.match(dash.text, /Document tampering/);
  const subj = fake.tables.fx_subjects.find(s => s.subject_type === 'individual' && fake.tables.fx_subject_emails.some(e => e.subject_id === s.id && e.email === 'jordan@mail.com'));
  assert.ok(fake.tables.fx_subject_links.some(l => l.account_id === acct.id && l.subject_id === subj.id));
});

test('a person whose email differs is still linked when DOB, last name and mobile match', async () => {
  const b = ctx.browser();
  await b.req('/request-access', { account_type: 'individual', mode: 'record', first_name: 'Jordan', last_name: 'Rivera',
    email: 'jr.work@company.com', phone: '415-555-0199', current_company: 'Acme', worker_type: 'employee', job_title: 'Rep', dob: '1990-04-12', attest: 'on' });
  const acct = ctx.accountByEmail('jr.work@company.com');
  await admin.req(`/admin/accounts/${acct.id}/approve`, { note: '' });
  await ctx.signIn(b, 'jr.work@company.com');
  const dash = await b.req('/dashboard');
  assert.match(dash.text, /Document tampering/);
  assert.ok(fake.tables.fx_subject_links.some(l => l.account_id === acct.id && l.linked_by === 'identity'));
  // Same DOB and last name but a different mobile and email: not linked.
  const c = ctx.browser();
  await c.req('/request-access', { account_type: 'individual', mode: 'record', first_name: 'Jordan', last_name: 'Rivera',
    email: 'someone.else@mail.com', phone: '212-555-0000', current_company: 'X', worker_type: 'employee', job_title: 'Rep', dob: '1990-04-12', attest: 'on' });
  const other = ctx.accountByEmail('someone.else@mail.com');
  await admin.req(`/admin/accounts/${other.id}/approve`, { note: '' });
  await ctx.signIn(c, 'someone.else@mail.com');
  assert.match((await c.req('/dashboard')).text, /There are no reports about you/);
});

test('businesses sign up with an EIN; there is no SSN option', async () => {
  const b = ctx.browser();
  const form = await b.req('/check-my-record/funded-business');
  assert.doesNotMatch(form.text, /SSN|No EIN/);
  const r = await b.req('/request-access', { account_type: 'merchant', mode: 'record', first_name: 'Joe', last_name: 'Smith', email: 'joe@joescafe.com',
    phone: '4155550111', business_legal_name: 'Joe’s Cafe LLC', state_of_registration: 'TX', job_title: 'Owner', attest: 'on' });
  assert.equal(r.status, 422);
  assert.match(r.text, /EIN must be 9 digits/);
});

test('no part of an SSN is stored anywhere', () => {
  const all = JSON.stringify(fake.tables);
  // Field names and readable values only: encrypted values, hashes and ids are random and can contain "ssn" by chance.
  const RANDOM = /^(v1:[A-Za-z0-9+/=:]+|[0-9a-f]{32,}|[0-9a-f-]{36})$/;
  const readable = JSON.stringify(fake.tables, (k, v) => (typeof v === 'string' && RANDOM.test(v) ? '' : v));
  assert.doesNotMatch(readable, /ssn|social security/i);
  assert.ok(!all.includes('1990-04-12'), 'dates of birth are only stored encrypted');
  assert.ok(emails.length > 0);
});

test('impersonation can be reported about individuals and vendors, not funded businesses', async () => {
  const R = require('../lib/reports');
  const funder = { account_type: 'company', company_type: 'funder' };
  const keys = t => R.categoriesFor(t, funder).map(c => c.key);
  assert.ok(keys('individual').includes('impersonation'));
  assert.ok(keys('company').includes('impersonation'));
  assert.ok(!keys('merchant').includes('impersonation'), 'funded businesses: defaults and document tampering only');
  const form = await lender.req('/reports/new/individual');
  assert.match(form.text, /Impersonation/);
  const r = await lender.req('/reports/new/funded-business', {
    subject_name: 'Imp Test LLC', subject_ein: '33-1234567', subject_state: 'TX', subject_contact: 'X', subject_email: 'x@imptest.com',
    category: 'impersonation', incident_date: '2026-08-01', description: 'x', certify: 'on',
  }, { files: { evidence: [{ name: 'a.pdf' }] } });
  assert.equal(r.status, 422);
});

test('vendors: old partner links redirect, the report form requires a vendor type, and the type shows in results', async () => {
  assert.equal((await lender.req('/search/partner')).location, '/search/vendor');
  assert.equal((await lender.req('/reports/new/partner')).location, '/reports/new/vendor');
  const choose = await lender.req('/reports/new');
  assert.match(choose.text, /A vendor/);
  assert.doesNotMatch(choose.text, /partner<\/strong>|A partner/);
  const form = await lender.req('/reports/new/vendor');
  assert.match(form.text, /Vendor type/);
  assert.match(form.text, /<option value="broker_partner"\s*>Broker partner<\/option>/);
  assert.match(form.text, /<option value="lender_partner"\s*>Lender partner<\/option>/);
  assert.match(form.text, /<option value="other"\s*>Other Service Providers<\/option>/);

  const base = { subject_name: 'Leaky CRM Inc', subject_website: 'https://leakycrm.com', subject_contact: 'Sam Vendor', subject_email: 'sam@leakycrm.com',
    category: 'data_mishandling', incident_date: '2026-08-01', description: 'Our merchant files were exposed.', certify: 'on' };
  const files = { files: { evidence: [{ name: 'e.pdf' }] } };
  const missing = await lender.req('/reports/new/vendor', base, files);
  assert.equal(missing.status, 422);
  assert.match(missing.text, /Vendor type is required/);
  const ok = await lender.req('/reports/new/vendor', { ...base, subject_vendor_type: 'crm_los' }, files);
  assert.equal(ok.status, 303, ok.text.slice(0, 300));
  const subj = fake.tables.fx_subjects.find(s => s.domain === 'leakycrm.com');
  assert.equal(subj.subject_type, 'company');
  assert.equal(subj.vendor_type, 'crm_los');
  await publishLatest();

  const r = await b2.req('/search/vendor', { website: 'leakycrm.com', certify: 'on' });
  assert.equal(r.status, 303, r.text.slice(0, 300));
  const res = await b2.req(r.location);
  assert.match(res.text, /Vendor &middot; Vendor diligence/);
  assert.match(res.text, /<dt>Vendor type<\/dt><dd>CRM or LOS<\/dd>/);
});
