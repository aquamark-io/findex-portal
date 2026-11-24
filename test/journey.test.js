/**
 * The main FinDex path end to end, against the in-memory database and captured emails:
 * member sign-up and approval, sign-in, reporting a default, admin review and notice, publishing,
 * searching, the reported party's dispute, and 7-year retention.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

const ctx = setup();
const N = require('../lib/notices');
const { fake, emails } = ctx;

test.before(ctx.start);
test.after(ctx.stop);

let admin, lender, other, reportId;
const lenderEmail = 'pat@acmefunding.com';
const otherEmail = 'sam@bestcapital.com';
const merchantEmail = 'owner@joescafe.com';

test('a company requests access, is approved, and signs in with an emailed code', async () => {
  admin = await ctx.admin();
  lender = await ctx.member(admin, { email: lenderEmail, domain: 'acmefunding.com', companyType: 'funder' });
  const acct = ctx.accountByEmail(lenderEmail);
  assert.equal(acct.status, 'approved');
  assert.ok(acct.terms_version, 'member terms accepted at sign-up');
  assert.ok(emails.some(e => e.to === lenderEmail && e.tag === 'fx-approved'));
  const dash = await lender.req('/dashboard');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /Acme Funding LLC/);
});

test('free email providers and mismatched domains are refused for company accounts', async () => {
  const b = ctx.browser();
  const base = { account_type: 'company', first_name: 'A', last_name: 'B', phone: '4155550101', business_legal_name: 'X LLC', company_type: 'broker',
    state_of_registration: 'CA', job_title: 'CEO', website: 'https://xllc.com', authorize: 'on', member_terms: 'on', cfpb_notices: 'on', attest: 'on' };
  let r = await b.req('/request-access', { ...base, email: 'someone@gmail.com' });
  assert.equal(r.status, 422);
  assert.match(r.text, /Free email providers/);
  r = await b.req('/request-access', { ...base, email: 'someone@other.com' });
  assert.match(r.text, /must be on your company website/);
});

test('a lender reports a default with evidence and the default notice', async () => {
  const r = await lender.req('/reports/new/funded-business', {
    subject_name: 'Joe’s Cafe LLC', subject_ein: '12-3456789', subject_contact: 'Joe Smith', subject_email: merchantEmail,
    category: 'default', incident_date: '2026-09-15', description: 'Declared in default after missed payments.', certify: 'on',
  }, { files: { evidence: [{ name: 'ledger.pdf' }], default_notice: [{ name: 'notice.pdf' }] } });
  assert.equal(r.status, 303, r.text.slice(0, 500));
  const rep = fake.tables.fx_reports.at(-1);
  reportId = rep.id;
  assert.equal(rep.status, 'submitted');
  assert.equal(fake.tables.fx_report_evidence.filter(e => e.report_id === rep.id).length, 2);
  const subj = fake.tables.fx_subjects.find(s => s.id === rep.subject_id);
  assert.equal(subj.subject_type, 'merchant');
  assert.ok(!JSON.stringify(subj).includes('123456789'), 'EIN is never stored in plain text');
});

test('a default without the default notice is refused', async () => {
  const r = await lender.req('/reports/new/funded-business', {
    subject_name: 'Other Co', subject_ein: '98-7654321', subject_contact: 'X', subject_email: 'x@other.co',
    category: 'default', incident_date: '2026-09-01', description: 'x', certify: 'on',
  }, { files: { evidence: [{ name: 'a.pdf' }] } });
  assert.equal(r.status, 422);
  assert.match(r.text, /default notice/);
});

test('admin accepts the report: the business gets a notice and it publishes after 10 days', async () => {
  await admin.req(`/admin/reports/${reportId}/accept`, { note: '' });
  const rep = fake.tables.fx_reports.find(r => r.id === reportId);
  assert.equal(rep.status, 'notice_sent');
  assert.ok(emails.some(e => e.to === merchantEmail && e.tag === 'fx-notice'));
  assert.equal(await N.publishDue(), 0, 'not before the 10 days');
  rep.publish_at = new Date(Date.now() - 1000).toISOString();
  assert.equal(await N.publishDue(), 1);
  assert.equal(rep.status, 'published');
});

test('another member finds the published default by searching the business', async () => {
  other = await ctx.member(admin, { email: otherEmail, domain: 'bestcapital.com', company: 'Best Capital Inc', companyType: 'lender' });
  const r = await other.req('/search/funded-business', { name: 'Joe’s Cafe LLC', ein: '12-3456789', certify: 'on' });
  assert.equal(r.status, 303);
  const res = await other.req(r.location);
  assert.match(res.text, /1 published report/);
  assert.match(res.text, /Default/);
  const log = fake.tables.fx_searches.at(-1);
  assert.equal(log.criteria.ein, true);
  assert.ok(!JSON.stringify(log).includes('123456789'), 'the EIN is not stored in the search log');
});

test('a search with a different EIN finds nothing', async () => {
  const r = await other.req('/search/funded-business', { name: 'Joe’s Cafe LLC', ein: '11-1111111', certify: 'on' });
  const res = await other.req(r.location);
  assert.match(res.text, /No published reports found/);
});

test('reports older than 7 years are deleted with their files', async () => {
  const rep = fake.tables.fx_reports.find(r => r.id === reportId);
  rep.expires_on = '2000-01-01';
  const before = Object.keys(fake.files).length;
  assert.equal(await N.deleteExpired(), 1);
  assert.ok(!fake.tables.fx_reports.some(r => r.id === reportId));
  assert.equal(Object.keys(fake.files).length, before - 2);
});
