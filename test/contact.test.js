/**
 * Contact form (/contact) and the admin Contact queue: reference numbers, confirmation and alert emails (the alert
 * never carries the message text), linking to accounts without telling the sender, spam limits, and audit entries.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

const ctx = setup();
const { fake, emails } = ctx;

test.before(ctx.start);
test.after(ctx.stop);

const rows = () => fake.tables.fx_contact_requests || [];
const said = r => decodeURIComponent(String(r.location || '').replace(/\+/g, ' '));
const SECRET = 'my secret details 4471';
let admin, member;

test('anyone can send a message: they get a reference and a confirmation; admin gets an alert without the message', async () => {
  const b = ctx.browser();
  const page = await b.req('/contact');
  assert.equal(page.status, 200);
  assert.match(page.text, /Contact Us/);
  assert.match(page.text, /A report about me or a dispute/);
  assert.match(page.text, /href="\/contact">Contact<\/a>/, 'footer link');

  const r = await b.req('/contact', { name: 'Robin Diaz', email: 'Robin@Example.com', topic: 'report_about_me', message: `Question about a report. ${SECRET}` });
  assert.equal(r.status, 200);
  const row = rows().at(-1);
  const ref = `FX-${row.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
  assert.match(r.text, new RegExp(`reference <strong>${ref}</strong>`));
  assert.equal(row.contact_email, 'robin@example.com');
  assert.equal(row.status, 'open');
  assert.equal(row.account_id, null);

  const confirm = ctx.lastEmail('robin@example.com', 'fx-contact-received');
  assert.ok(confirm);
  assert.match(confirm.subject, new RegExp(ref));
  assert.match(confirm.text, /Hi Robin,/);
  const alert = ctx.lastEmail(process.env.ONBOARDING_NOTIFY_EMAIL, 'fx-admin-contact');
  assert.ok(alert);
  assert.match(alert.subject, new RegExp(ref));
  assert.ok(!alert.text.includes(SECRET) && !alert.html.includes(SECRET), 'the alert never includes the message');
  assert.ok(!confirm.text.includes(SECRET), 'nor does the confirmation');
});

test('missing email, topic or message is refused with field errors', async () => {
  const before = rows().length;
  const r = await ctx.browser().req('/contact', { name: '', email: 'nope', topic: 'bogus', message: 'hi' });
  assert.equal(r.status, 422);
  assert.match(r.text, /valid email address/);
  assert.match(r.text, /choose a topic/);
  assert.match(r.text, /how we can help/);
  assert.equal(rows().length, before);
});

test('the honeypot looks like success but saves and sends nothing', async () => {
  const before = rows().length;
  const mark = emails.length;
  const r = await ctx.browser().req('/contact', { email: 'bot@spam.com', topic: 'other', message: 'Buy now buy now', company_fax: 'x' });
  assert.equal(r.status, 200);
  assert.match(r.text, /we received your message/);
  assert.equal(rows().length, before);
  assert.equal(emails.length, mark);
});

test('at most 5 messages per hour from one network', async () => {
  const b = ctx.browser();
  for (let i = 0; i < 5; i++) assert.equal((await b.req('/contact', { email: `a${i}@example.com`, topic: 'other', message: 'Hello there' })).status, 200);
  const r = await b.req('/contact', { email: 'a6@example.com', topic: 'other', message: 'Hello there' });
  assert.equal(r.status, 429);
  assert.match(r.text, /Too many messages/);
});

test('signed-in members get their details filled in and the message linked to their account', async () => {
  admin = await ctx.admin();
  member = await ctx.member(admin, { email: 'pat@acmefunding.com', domain: 'acmefunding.com' });
  const acct = ctx.accountByEmail('pat@acmefunding.com');
  const page = await member.req('/contact?topic=search_api');
  assert.match(page.text, /value="pat@acmefunding.com"/);
  assert.match(page.text, /value="Pat Lee"/);
  assert.match(page.text, /<option value="search_api" selected>/);
  assert.match(page.text, /href="\/dashboard"/, 'member nav in the header');
  await member.req('/contact', { name: 'Pat Lee', email: 'pat@acmefunding.com', topic: 'search_api', message: 'How do I use the API?' });
  assert.equal(rows().at(-1).account_id, acct.id);
  assert.ok(fake.tables.fx_events.some(e => e.event === 'contact_sent' && e.account_id === acct.id));
});

test('a signed-out sender whose email matches an account is linked, and is not told so', async () => {
  const acct = ctx.accountByEmail('pat@acmefunding.com');
  const known = await ctx.browser().req('/contact', { email: 'PAT@acmefunding.com', topic: 'account_access', message: 'I cannot sign in.' });
  assert.equal(rows().at(-1).account_id, acct.id);
  const unknown = await ctx.browser().req('/contact', { email: 'nobody@nowhere.com', topic: 'account_access', message: 'I cannot sign in.' });
  assert.equal(rows().at(-1).account_id, null);
  const strip = t => t.replace(/FX-[0-9A-F]{6}/g, 'FX-REF');
  assert.equal(strip(known.text), strip(unknown.text), 'same page either way');
});

test('admin works the queue: open, read (audited), note, in progress, closed', async () => {
  const row = rows().find(x => x.contact_email === 'robin@example.com');
  const list = await admin.req('/admin/contact');
  assert.equal(list.status, 200);
  assert.match(list.text, /Robin Diaz/);
  assert.match(list.text, /A report about me or a dispute/);

  const page = await admin.req(`/admin/contact/${row.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(SECRET));
  assert.match(page.text, /Reply by email/);
  assert.equal(fake.tables.fx_admin_audit.at(-1).action, 'contact_opened');
  assert.equal(fake.tables.fx_admin_audit.at(-1).target_id, row.id);

  let r = await admin.req(`/admin/contact/${row.id}`, { status: 'in_progress', note: 'Asked the reporter for details.' });
  assert.match(said(r), /Marked in progress/);
  assert.equal(row.status, 'in_progress');
  assert.equal(row.admin_note, 'Asked the reporter for details.');
  r = await admin.req(`/admin/contact/${row.id}`, { status: 'closed', note: 'Asked the reporter for details.' });
  assert.equal(row.status, 'closed');
  assert.ok(row.closed_at);
  const e = fake.tables.fx_admin_audit.at(-1);
  assert.equal(e.action, 'contact_updated');
  assert.deepEqual([e.detail.from, e.detail.to], ['in_progress', 'closed']);
  assert.ok(!JSON.stringify(fake.tables.fx_admin_audit).includes(SECRET), 'the audit log never holds the message');

  const closed = await admin.req('/admin/contact?status=closed');
  assert.match(closed.text, /Robin Diaz/);
  const audit = await admin.req('/admin/audit?action=contact_updated');
  assert.match(audit.text, /Contact message updated/);
});

test('members and signed-out visitors cannot open the admin queue', async () => {
  assert.equal((await member.req('/admin/contact')).location, '/admin/login');
  assert.equal((await ctx.browser().req(`/admin/contact/${rows()[0].id}`)).location, '/admin/login');
});
