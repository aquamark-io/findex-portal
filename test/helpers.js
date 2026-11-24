/**
 * Test harness: environment, the in-memory database, captured Postmark emails, and a small cookie-keeping
 * browser. Each test file calls setup() once, before requiring anything from the app.
 */
const crypto = require('crypto');

function setup(extraEnv = {}) {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORTAL_BASE_URL: 'https://app.joinfindex.com',
    SUPABASE_URL: 'http://fake.local',
    SUPABASE_SERVICE_KEY: 'fake',
    POSTMARK_SERVER_TOKEN: 'test-token',
    ONBOARDING_NOTIFY_EMAIL: 'admin@findex.test',
    JWT_SECRET: 'j'.repeat(40),
    ADMIN_OWNER_EMAIL: 'owner@findex.test',
    FIELD_ENCRYPTION_KEY: 'test-encryption-key-that-is-long-enough-1234',
    FIELD_HASH_KEY: 'test-hash-key-that-is-long-enough-and-different',
    DISABLE_DAILY_JOB: 'true',
    TEST_NOTIFICATIONS: 'true',
    ...extraEnv,
  });
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.TURNSTILE_SITE_KEY;

  // Capture Postmark sends; let every other request through.
  const emails = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (String(url) === 'https://api.postmarkapp.com/server') {
      const ok = ctx.postmarkTokenOk !== false;
      return new Response(JSON.stringify(ok ? { Name: 'FinDex' } : { ErrorCode: 10 }), { status: ok ? 200 : 401 });
    }
    if (String(url).startsWith('https://api.postmarkapp.com/')) {
      const b = JSON.parse(opts.body);
      const MessageID = crypto.randomUUID();
      emails.push({ to: b.To, subject: b.Subject, text: b.TextBody, html: b.HtmlBody, tag: b.Tag, MessageID });
      return new Response(JSON.stringify({ MessageID, ErrorCode: 0 }), { status: 200 });
    }
    return realFetch(url, opts);
  };

  const { createFake } = require('./fake-supabase');
  const fake = createFake();
  require('../lib/supabase').set(fake);
  const origErr = console.error;
  console.error = (...a) => { if (process.env.SHOW_ERRORS) origErr(...a); };
  const app = require('../server');

  const ctx = { fake, emails, app, base: null, server: null, realFetch };
  ctx.start = () => new Promise(r => { ctx.server = app.listen(0, () => { ctx.base = `http://127.0.0.1:${ctx.server.address().port}`; r(); }); });
  ctx.stop = () => new Promise(r => { console.error = origErr; ctx.server.close(r); });

  let ipSeq = 10;
  // A browser keeps cookies and has its own IP (via X-Forwarded-For, which the app trusts one hop of).
  ctx.browser = () => {
    const jar = {};
    const ip = `10.0.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
    return {
      jar,
      async req(path, form, { files } = {}) {
        const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'x-forwarded-for': ip };
        let body;
        if (files) {
          body = new FormData();
          for (const [k, v] of Object.entries(form || {})) [].concat(v).forEach(x => body.append(k, x));
          for (const [field, list] of Object.entries(files)) {
            for (const f of [].concat(list)) body.append(field, new Blob([f.content || 'file'], { type: f.type || 'application/pdf' }), f.name || 'file.pdf');
          }
        } else if (form) {
          headers['content-type'] = 'application/x-www-form-urlencoded';
          const p = new URLSearchParams();
          for (const [k, v] of Object.entries(form)) [].concat(v).forEach(x => p.append(k, x));
          body = p.toString();
        }
        const res = await ctx.realFetch(ctx.base + path, { method: form || files ? 'POST' : 'GET', headers, body, redirect: 'manual' });
        for (const c of res.headers.getSetCookie()) {
          const [k, ...v] = c.split(';')[0].split('=');
          if (/Expires=Thu, 01 Jan 1970/i.test(c) || v.join('=') === '') delete jar[k]; else jar[k] = v.join('=');
        }
        return { status: res.status, location: res.headers.get('location'), text: await res.text() };
      },
    };
  };

  ctx.wait = ms => new Promise(r => setTimeout(r, ms));
  ctx.lastEmail = (to, tag) => [...emails].reverse().find(e => e.to === to && (!tag || e.tag === tag));
  ctx.codeFor = async (to, after = 0) => {
    for (let i = 0; i < 100; i++) {
      const e = emails.slice(after).reverse().find(x => x.to === to && x.tag === 'fx-sign-in-code');
      if (e) return e.subject.match(/(\d{6})/)[1];
      await ctx.wait(10);
    }
    throw new Error(`no sign-in code for ${to}`);
  };
  ctx.signIn = async (b, email) => {
    const mark = emails.length;
    await b.req('/login', { email });
    const r = await b.req('/login/verify', { code: await ctx.codeFor(email, mark) });
    if (r.location !== '/dashboard') throw new Error(`sign-in failed for ${email}: ${r.status}`);
    return b;
  };
  ctx.adminCodeFor = async (to, after = 0) => {
    for (let i = 0; i < 100; i++) {
      const e = emails.slice(after).reverse().find(x => x.to === to && x.tag === 'fx-admin-sign-in-code');
      if (e) return e.subject.match(/(\d{6})/)[1];
      await ctx.wait(10);
    }
    throw new Error(`no admin sign-in code for ${to}`);
  };
  // Signs in a named admin with an emailed code (the owner by default). Returns the browser.
  ctx.admin = async (email = process.env.ADMIN_OWNER_EMAIL) => {
    const b = ctx.browser();
    const mark = emails.length;
    await b.req('/admin/login', { email });
    const r = await b.req('/admin/login/verify', { code: await ctx.adminCodeFor(email, mark) });
    if (r.location !== '/admin') throw new Error(`admin sign-in failed for ${email}: ${r.status}`);
    return b;
  };
  const accountByEmail = email => fake.tables.fx_accounts.find(a => a.email === email);
  ctx.accountByEmail = accountByEmail;
  // Sign up through the real form, approve as admin, and sign in. Returns the signed-in browser.
  ctx.member = async (admin, { email, domain, company = 'Acme Funding LLC', companyType = 'funder', state = 'NY' }) => {
    const b = ctx.browser();
    const r = await b.req('/request-access', {
      account_type: 'company', first_name: 'Pat', last_name: 'Lee', email, phone: '(415) 555-0100',
      business_legal_name: company, company_type: companyType, state_of_registration: state, job_title: 'Ops', website: `https://${domain}`,
      authorize: 'on', member_terms: 'on', cfpb_notices: 'on', attest: 'on',
    });
    if (r.location !== '/request-access/received') throw new Error(`sign-up failed for ${email}: ${r.status} ${r.text.slice(0, 400)}`);
    await admin.req(`/admin/accounts/${accountByEmail(email).id}/approve`, { note: '' });
    return ctx.signIn(b, email);
  };
  return ctx;
}

// YYYY-MM-DD n days before today (defaults must be reported within 90 days, so test dates stay recent).
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

module.exports = { setup, daysAgo };
