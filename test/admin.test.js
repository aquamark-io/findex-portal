/**
 * Admin hardening: named admins with emailed codes (no shared password), admin settings,
 * the append-only audit log (every admin action recorded with who, what, when and IP), and the launch checklist.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { setup, daysAgo } = require('./helpers');
const DEFAULT_DATE = daysAgo(30);

const ctx = setup();
const supabase = require('../lib/supabase');
const launch = require('../lib/launch');
const { fake, emails } = ctx;

test.before(ctx.start);
test.after(ctx.stop);

const OWNER = 'owner@findex.test';
const audit = action => fake.tables.fx_admin_audit.filter(e => !action || e.action === action);
const lastAudit = action => audit(action).at(-1);
const adminRow = email => (fake.tables.fx_admins || []).find(a => a.email === email);
// The flash message an admin action redirected with.
const said = r => decodeURIComponent(String(r.location || '').replace(/\+/g, ' '));

let owner, lender, reportId;

// ---------- sign-in ----------

test('the owner (ADMIN_OWNER_EMAIL) signs in with an emailed code; their admin record is created on first sign-in', async () => {
  assert.equal(adminRow(OWNER), undefined);
  owner = await ctx.admin(OWNER);
  const row = adminRow(OWNER);
  assert.ok(row, 'owner row created');
  assert.equal(row.status, 'active');
  assert.ok(row.last_login_at);
  const e = lastAudit('admin_login');
  assert.equal(e.admin_id, row.id);
  assert.equal(e.admin_email, OWNER);
  assert.equal(e.detail.method, 'code');
  assert.ok(e.ip, 'IP recorded');
  const page = await owner.req('/admin');
  assert.equal(page.status, 200);
  assert.match(page.text, /Audit Log/);
});

test('an email that is not an admin gets no code, and the screen does not say so', async () => {
  const b = ctx.browser();
  const mark = emails.length;
  const r = await b.req('/admin/login', { email: 'stranger@example.com' });
  assert.equal(r.location, '/admin/login/verify');
  const v = await b.req('/admin/login/verify');
  assert.match(v.text, /If <strong>stranger@example.com<\/strong> is an admin/);
  await ctx.wait(50);
  assert.equal(emails.slice(mark).length, 0, 'nothing emailed');
  const bad = await b.req('/admin/login/verify', { code: '123456' });
  assert.equal(bad.status, 401);
  assert.equal(adminRow('stranger@example.com'), undefined);
  assert.equal((await b.req('/admin')).location, '/admin/login');
});

test('a wrong code is refused and recorded; codes are single use', async () => {
  const b = ctx.browser();
  const mark = emails.length;
  await b.req('/admin/login', { email: OWNER });
  const code = await ctx.adminCodeFor(OWNER, mark);
  const wrong = code === '000000' ? '111111' : '000000';
  const r = await b.req('/admin/login/verify', { code: wrong });
  assert.equal(r.status, 401);
  assert.equal(lastAudit('admin_login_failed').admin_email, OWNER);
  // A second browser can't reuse the code after it has been used once.
  const ok = await b.req('/admin/login/verify', { code });
  assert.equal(ok.location, '/admin');
  const b2 = ctx.browser();
  await b2.req('/admin/login', { email: OWNER });
  const again = await b2.req('/admin/login/verify', { code });
  assert.notEqual(again.location, '/admin');
});

test('an account session can never open admin pages', async () => {
  const b = ctx.browser();
  const token = jwt.sign({ sub: adminRow(OWNER).id }, process.env.JWT_SECRET, { expiresIn: '1h', audience: 'fx-session' });
  b.jar.fx_admin = token;
  assert.equal((await b.req('/admin')).location, '/admin/login');
  // The old shared-password token (no admin named in it) no longer works either.
  b.jar.fx_admin = jwt.sign({ scope: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h', audience: 'fx-admin' });
  assert.equal((await b.req('/admin')).location, '/admin/login');
});

test('there is no shared-password sign-in, even if ADMIN_PASSWORD is set again', async () => {
  process.env.ADMIN_PASSWORD = 'old-shared-password';
  try {
    const b = ctx.browser();
    const page = await b.req('/admin/login');
    assert.doesNotMatch(page.text, /password/i);
    const r = await b.req('/admin/login/password', { password: 'old-shared-password' });
    assert.notEqual(r.location, '/admin');
    assert.equal((await b.req('/admin')).location, '/admin/login');
    // An old shared-password session cookie no longer opens admin.
    b.jar.fx_admin = jwt.sign({ scope: 'admin', sub: 'shared-password' }, process.env.JWT_SECRET, { expiresIn: '1h', audience: 'fx-admin' });
    assert.equal((await b.req('/admin')).location, '/admin/login');
  } finally { delete process.env.ADMIN_PASSWORD; }
});

// ---------- settings ----------

test('the owner adds an admin, who then signs in with their own code', async () => {
  const r = await owner.req('/admin/settings/admins', { name: 'Sam Rivera', email: ' Sam@FinDex.test ' });
  assert.match(said(r), /Sam Rivera was added/);
  const row = adminRow('sam@findex.test');
  assert.equal(row.name, 'Sam Rivera');
  assert.equal(row.added_by, adminRow(OWNER).id);
  const e = lastAudit('admin_added');
  assert.equal(e.target_id, row.id);
  assert.equal(e.admin_email, OWNER);
  const dup = await owner.req('/admin/settings/admins', { name: 'Sam again', email: 'sam@findex.test' });
  assert.match(said(dup), /already an admin/);
  const sam = await ctx.admin('sam@findex.test');
  assert.equal((await sam.req('/admin/settings')).status, 200);
});

test('nobody can disable themselves or the owner', async () => {
  const sam = await ctx.admin('sam@findex.test');
  const self = await sam.req(`/admin/settings/admins/${adminRow('sam@findex.test').id}/disable`, {});
  assert.match(said(self), /can’t disable yourself/);
  const own = await sam.req(`/admin/settings/admins/${adminRow(OWNER).id}/disable`, {});
  assert.match(said(own), /owner/);
  assert.equal(adminRow(OWNER).status, 'active');
  assert.equal(adminRow('sam@findex.test').status, 'active');
});

test('disabling an admin ends their session at once and stops new codes; re-enabling restores access', async () => {
  const sam = await ctx.admin('sam@findex.test');
  const id = adminRow('sam@findex.test').id;
  await owner.req(`/admin/settings/admins/${id}/disable`, {});
  assert.equal(adminRow('sam@findex.test').status, 'disabled');
  assert.equal(lastAudit('admin_disabled').target_id, id);
  assert.equal((await sam.req('/admin')).location, '/admin/login');
  const mark = emails.length;
  await ctx.browser().req('/admin/login', { email: 'sam@findex.test' });
  await ctx.wait(50);
  assert.equal(emails.slice(mark).filter(e => e.to === 'sam@findex.test').length, 0, 'no code for a disabled admin');
  const list = await owner.req('/admin/settings');
  assert.match(list.text, /Disabled/);

  await owner.req(`/admin/settings/admins/${id}/enable`, {});
  assert.equal(adminRow('sam@findex.test').status, 'active');
  assert.equal(lastAudit('admin_enabled').target_id, id);
  await ctx.admin('sam@findex.test');

  await owner.req(`/admin/settings/admins/${id}/rename`, { name: 'Samantha Rivera' });
  assert.equal(adminRow('sam@findex.test').name, 'Samantha Rivera');
  assert.equal(lastAudit('admin_renamed').detail.from, 'Sam Rivera');
});

// ---------- audit log ----------

test('account approvals and denials are recorded with the admin, target and IP', async () => {
  lender = await ctx.member(owner, { email: 'pat@acmefunding.com', domain: 'acmefunding.com' });
  const acct = ctx.accountByEmail('pat@acmefunding.com');
  const e = lastAudit('account_approved');
  assert.equal(e.target_type, 'account');
  assert.equal(e.target_id, acct.id);
  assert.equal(e.admin_email, OWNER);
  assert.equal(e.detail.name, 'Acme Funding LLC');
  assert.ok(e.ip);

  const b = ctx.browser();
  await b.req('/request-access', {
    account_type: 'company', first_name: 'Lee', last_name: 'Ng', email: 'lee@nopefunding.com', phone: '(415) 555-0101',
    business_legal_name: 'Nope Funding LLC', company_type: 'funder', state_of_registration: 'CA', job_title: 'Ops', website: 'https://nopefunding.com',
    authorize: 'on', member_terms: 'on', cfpb_notices: 'on', attest: 'on',
  });
  const nope = ctx.accountByEmail('lee@nopefunding.com');
  await owner.req(`/admin/accounts/${nope.id}/deny`, { note: '' });
  assert.equal(lastAudit('account_denied').target_id, nope.id);
});

test('report accept, reject, evidence opens, dispute decisions and test deletes are recorded', async () => {
  const submit = async (name, ein) => {
    const r = await lender.req('/reports/new/funded-business', {
      subject_name: name, subject_ein: ein, subject_state: 'TX', subject_contact: 'Joe Smith', subject_email: `owner@${ein.replace(/\D/g, '')}.com`,
      category: 'default', incident_date: DEFAULT_DATE, description: 'Declared in default after missed payments.', certify: 'on',
    }, { files: { evidence: [{ name: 'ledger.pdf' }], default_notice: [{ name: 'notice.pdf' }] } });
    assert.equal(r.status, 303, r.text.slice(0, 300));
    return fake.tables.fx_reports.at(-1);
  };
  const rep = await submit('Joe’s Cafe LLC', '12-3456789');
  reportId = rep.id;

  const file = fake.tables.fx_report_evidence.find(f => f.report_id === rep.id);
  const open = await owner.req(`/admin/reports/${rep.id}/files/${file.id}`);
  assert.match(open.location, /^https:\/\/storage\.test\//);
  const ev = lastAudit('evidence_opened');
  assert.equal(ev.target_id, rep.id);
  assert.equal(ev.detail.file, file.file_name);

  await owner.req(`/admin/reports/${rep.id}/accept`, { note: '' });
  assert.equal(lastAudit('report_accepted').target_id, rep.id);

  const rep2 = await submit('Bad Data Inc', '22-3456789');
  await owner.req(`/admin/reports/${rep2.id}/reject`, { reason: 'Evidence does not show a default.' });
  assert.equal(lastAudit('report_rejected').target_id, rep2.id);

  // Dispute decision: the reported party disputed; the admin upholds it (the report publishes).
  const disputer = ctx.accountByEmail('pat@acmefunding.com');
  fake.tables.fx_reports.find(r => r.id === rep.id).status = 'disputed';
  await supabase.from('fx_disputes').insert({ report_id: rep.id, account_id: disputer.id, status: 'open', due_at: new Date(Date.now() + 864e5).toISOString() });
  const res = await owner.req(`/admin/reports/${rep.id}/resolve`, { outcome: 'upheld', note: 'Evidence supports the report.' });
  assert.match(said(res), /Dispute resolved: upheld/);
  assert.equal(fake.tables.fx_reports.find(r => r.id === rep.id).status, 'published');
  assert.equal(lastAudit('dispute_upheld').target_id, rep.id);

  // Deleting a [TEST] report.
  fake.tables.fx_reports.find(r => r.id === rep2.id).is_test = true;
  await owner.req(`/admin/reports/${rep2.id}/delete`, {});
  assert.equal(lastAudit('test_report_deleted').target_id, rep2.id);
  assert.ok(audit('test_report_deleted').length, 'the audit entry survives the report being deleted');
});

test('API access decisions and admin key revokes are recorded', async () => {
  const acct = ctx.accountByEmail('pat@acmefunding.com');
  await lender.req('/api-access/request', { use_note: 'Underwriting' });
  await owner.req(`/admin/api/${acct.id}/approve`, {});
  assert.equal(lastAudit('api_access_approved').target_id, acct.id);
  await lender.req('/api-access/keys', { label: 'Prod' });
  const key = fake.tables.fx_api_keys.find(k => k.account_id === acct.id && !k.revoked_at);
  assert.ok(key, 'key created');
  await owner.req(`/admin/accounts/${acct.id}/api-keys/${key.id}/revoke`, {});
  const e = lastAudit('api_key_revoked');
  assert.equal(e.detail.key_id, key.id);
  assert.ok(!JSON.stringify(e).includes(key.key_hash), 'never the key itself');
  await owner.req(`/admin/api/${acct.id}/revoke`, {});
  assert.equal(lastAudit('api_access_revoked').target_id, acct.id);
});

test('opening an employment authorization is recorded', async () => {
  const acct = ctx.accountByEmail('pat@acmefunding.com');
  const path = `authorizations/${crypto.randomUUID()}.pdf`;
  fake.files[`fx-evidence/${path}`] = { buffer: Buffer.from('pdf'), contentType: 'application/pdf' };
  const { data: auth } = await supabase.from('fx_authorizations').insert({ account_id: acct.id, storage_path: path, file_name: 'auth.pdf', mime_type: 'application/pdf', size_bytes: 3, sha256: 'x' }).select('*').single();
  const r = await owner.req(`/admin/authorizations/${auth.id}`);
  assert.match(r.location, /^https:\/\/storage\.test\//);
  const e = lastAudit('authorization_opened');
  assert.equal(e.target_id, acct.id);
  assert.equal(e.detail.file, 'auth.pdf');
});

test('audit entries can’t be changed or deleted', async () => {
  const before = JSON.stringify(fake.tables.fx_admin_audit);
  const up = await supabase.from('fx_admin_audit').update({ action: 'nothing' }).eq('action', 'admin_login');
  assert.ok(up.error, 'update refused');
  const del = await supabase.from('fx_admin_audit').delete().not('id', 'is', null);
  assert.ok(del.error, 'delete refused');
  assert.equal(JSON.stringify(fake.tables.fx_admin_audit), before);
  // And the app offers no way to: there are no edit or delete routes under /admin/audit.
  const r = await owner.req('/admin/audit/1/delete', {});
  assert.equal(r.status, 404);
});

test('a failed audit write stops the action instead of letting it go unrecorded', async () => {
  const acct = ctx.accountByEmail('pat@acmefunding.com');
  const file = fake.tables.fx_report_evidence.find(f => f.report_id === reportId);
  const realFrom = fake.from;
  fake.from = table => (table === 'fx_admin_audit' ? { insert: async () => ({ error: { message: 'down' } }) } : realFrom(table));
  try {
    const r = await owner.req(`/admin/reports/${reportId}/files/${file.id}`);
    assert.equal(r.status, 500);
    assert.equal(r.location, null, 'the file was not opened');
  } finally { fake.from = realFrom; }
  assert.ok(acct);
});

test('the audit log page lists entries and filters by admin, action and date', async () => {
  const all = await owner.req('/admin/audit');
  assert.equal(all.status, 200);
  assert.match(all.text, /<td>Account approved<\/td>/);

  const samId = adminRow('sam@findex.test').id;
  const bySam = await owner.req(`/admin/audit?admin=${samId}`);
  assert.match(bySam.text, /sam@findex.test/);
  assert.doesNotMatch(bySam.text, /<td>Account approved<\/td>/);


  const approvals = await owner.req('/admin/audit?action=account_approved');
  assert.match(approvals.text, /Acme Funding LLC/);
  assert.doesNotMatch(approvals.text, /<td>Report accepted/);

  const today = launch.pacificNow().day;
  const todays = await owner.req(`/admin/audit?from=${today}&to=${today}`);
  assert.match(todays.text, /<td>Account approved<\/td>/);
  const past = await owner.req('/admin/audit?from=2020-01-01&to=2020-01-31');
  assert.match(past.text, /No entries match/);
  const junk = await owner.req('/admin/audit?admin=x&action=drop&from=nope');
  assert.equal(junk.status, 200, 'bad filters are ignored');
});

// ---------- launch checklist ----------

test('the launch checklist shows pass or fail for each item and never shows setting values', async () => {
  const saved = { ...process.env };
  try {
    const r = await owner.req('/admin/launch');
    assert.equal(r.status, 200);
    for (const label of ['Required Render settings are present', 'Postmark is sending', 'The daily job is running', 'Test accounts and reports are removed', 'Legal versions are set']) {
      assert.ok(r.text.includes(label), label);
    }
    for (const secret of [process.env.JWT_SECRET, process.env.FIELD_ENCRYPTION_KEY, process.env.FIELD_HASH_KEY, process.env.POSTMARK_SERVER_TOKEN]) {
      assert.ok(!r.text.includes(secret), 'no setting values on the page');
    }
    const checks = Object.fromEntries((await launch.runChecks()).map(c => [c.key, c]));
    assert.equal(checks.settings.ok, false, 'POSTMARK_WEBHOOK_TOKEN etc. are not set in tests');
    assert.match(checks.settings.detail, /POSTMARK_WEBHOOK_TOKEN/);
    assert.equal(checks.postmark.ok, true);
    assert.equal(checks.daily_job.ok, false, 'never ran');
    assert.equal(checks.legal.ok, false, 'member terms are still a draft');
    assert.ok(!checks.turnstile, 'Turnstile is not part of the checklist');

    // Flip each one to passing.
    Object.assign(process.env, { POSTMARK_WEBHOOK_TOKEN: 'x', ONBOARDING_FROM_EMAIL: 'FinDex <a@b.co>', NODE_ENV: 'production' });
    delete process.env.DISABLE_DAILY_JOB;
    await supabase.from('fx_events').insert({ event: 'daily_job', actor: 'system', detail: { day: launch.pacificNow().day, started: true } });
    const after = Object.fromEntries((await launch.runChecks()).map(c => [c.key, c]));
    for (const k of ['settings', 'production', 'daily_job']) assert.equal(after[k].ok, true, k);

    ctx.postmarkTokenOk = false;
    assert.equal((await launch.runChecks()).find(c => c.key === 'postmark').ok, false, 'a rejected token fails');
  } finally {
    ctx.postmarkTokenOk = true;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('the daily job check allows yesterday’s run before 6 AM Pacific', async () => {
  fake.tables.fx_events = fake.tables.fx_events.filter(e => e.event !== 'daily_job');
  const early = new Date('2026-12-02T12:00:00Z'); // 4 AM Pacific
  await supabase.from('fx_events').insert({ event: 'daily_job', actor: 'system', detail: { day: '2026-12-01' } });
  delete process.env.DISABLE_DAILY_JOB;
  try {
    assert.equal((await launch.dailyJobCheck(early)).ok, true);
    assert.equal((await launch.dailyJobCheck(new Date('2026-12-02T18:00:00Z'))).ok, false, 'after 6 AM it must have run today');
  } finally { process.env.DISABLE_DAILY_JOB = 'true'; }
  process.env.DISABLE_DAILY_JOB = 'true';
  assert.equal((await launch.dailyJobCheck(early)).ok, false, 'fails while the job is turned off');
});

test('the checklist flags test records and the two kinds of old record', async () => {
  const c0 = await launch.testDataCounts();
  await supabase.from('fx_subjects').insert({ subject_type: 'individual', name: 'Old Person', dob_enc: 'v1:x', identity_hash: 'person:old-ssn-key', contact_name: null });
  await supabase.from('fx_subjects').insert({ subject_type: 'merchant', name: 'No Key LLC', ein_enc: 'v1:y', identity_hash: 'ein:abc', contact_name: 'X', biz_key: null });
  await supabase.from('fx_subjects').insert({ subject_type: 'individual', name: 'New Person', dob_enc: 'v1:z', identity_hash: 'person:v2:new' });
  fake.tables.fx_accounts.find(a => a.email === 'lee@nopefunding.com').is_test = true;
  const c = await launch.testDataCounts();
  assert.equal(c.oldPersonKeys, c0.oldPersonKeys + 1);
  assert.equal(c.businessesNoNameKey, c0.businessesNoNameKey + 1);
  assert.equal(c.testAccounts, c0.testAccounts + 1);
  const check = (await launch.runChecks()).find(x => x.key === 'test_data');
  assert.equal(check.ok, false);
  assert.match(check.detail, /old SSN-based key/);
  assert.match(check.detail, /no name \+ state key/);
});

test('"Send a test email" sends through Postmark to the signed-in admin and is recorded', async () => {
  const r = await owner.req('/admin/launch/test-email', {});
  assert.match(said(r), /Test email sent to owner@findex.test/);
  assert.ok(ctx.lastEmail(OWNER, 'fx-launch-test'));
  assert.equal(lastAudit('test_email_sent').detail.to, OWNER);
});

test('signing out is recorded and ends the session', async () => {
  await owner.req('/admin/logout', {});
  assert.equal(lastAudit('admin_logout').admin_email, OWNER);
  assert.equal((await owner.req('/admin')).location, '/admin/login');
});

test('emails use the current style: white header with the FinDex wordmark, solid plum and magenta, no gradients', () => {
  const { templates, apiEmails } = require('../lib/email');
  const samples = [
    templates.signInCode({ first_name: 'Pat' }, '123456'),
    templates.adminSignInCode({ name: 'Pat Lee' }, '123456'),
    templates.launchTestEmail(),
    apiEmails.approved({ first_name: 'Pat', business_legal_name: 'Acme' }),
  ];
  for (const t of samples) {
    assert.doesNotMatch(t.html, /gradient/i);
    assert.match(t.html, /background:#ffffff;padding:22px 32px;border-bottom:1px solid #e4deec/);
    assert.match(t.html, /color:#45138c;">Fin<span style="color:#d63d8f;">Dex<\/span>/);
    assert.doesNotMatch(t.html, /border-radius:1\dpx/, 'square corners');
  }
  assert.match(samples[3].html, /background:#b8287a/, 'magenta button');
});
