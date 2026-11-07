/**
 * Postmark (raw fetch) + the five FinDex emails. Every email has HTML + plain text.
 * Never pass DOB, SSN, or EIN into any of these templates.
 */
const { ACCOUNT_TYPES, COMPANY_TYPES, WORKER_TYPES, STATES } = require('./validate');

const FOOTER = 'FinDex is independently administered by Aquamark.';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baseUrl = () => (process.env.PORTAL_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

async function sendEmail({ to, subject, text, html, tag }) {
  if (!process.env.POSTMARK_SERVER_TOKEN) throw new Error('POSTMARK_SERVER_TOKEN is not set');
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: process.env.ONBOARDING_FROM_EMAIL || 'FinDex <christina@aquamark.io>',
      To: to,
      Subject: subject,
      TextBody: text,
      HtmlBody: html,
      Tag: tag,
      MessageStream: 'outbound',
      TrackOpens: false,
      TrackLinks: 'None',
    }),
  });
  if (!res.ok) throw new Error(`Postmark ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// ---------- layout ----------

function htmlLayout({ preheader, heading, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f6f0fd;font-family:Inter,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c0f2e;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f0fd;padding:32px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #ebdff9;border-radius:16px;overflow:hidden;">
    <tr><td style="background:#5a1a9a;background-image:linear-gradient(120deg,#45138c 0%,#6a1fb0 55%,#c2338f 100%);padding:22px 32px;">
      <span style="font-size:24px;font-weight:700;letter-spacing:-0.02em;color:#ffffff;">FinDex</span>
    </td></tr>
    <tr><td style="padding:32px 32px 8px;">
      <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:700;color:#3d0f7a;">${esc(heading)}</h1>
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:20px 32px 28px;border-top:1px solid #ebdff9;font-size:12px;line-height:1.6;color:#7a6c92;">${esc(FOOTER)}</td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

const p = s => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#4b3d63;">${s}</p>`;
const button = (href, label) =>
  `<p style="margin:8px 0 24px;"><a href="${esc(href)}" style="display:inline-block;background:#3d0f7a;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:10px;">${esc(label)}</a></p>`;
const textLayout = lines => [...lines, '', '--', FOOTER].join('\n');

const greet = account => (account.first_name ? `Hi ${account.first_name},` : 'Hi,');

// ---------- 1. applicant: under review ----------

function underReview(account) {
  const what = account.account_type === 'company'
    ? `your request for a FinDex account for ${account.business_legal_name}`
    : 'your request for FinDex access';
  const subject = 'Your FinDex request is under review';
  const lines = [
    greet(account),
    '',
    `Thank you for submitting ${what}. Every request is reviewed before access is granted.`,
    '',
    "We'll email you at this address once a decision has been made. No action is needed in the meantime.",
  ];
  return {
    subject,
    text: textLayout(lines),
    html: htmlLayout({
      preheader: 'We received your request and will email you once it has been reviewed.',
      heading: 'Your request is under review',
      bodyHtml: p(esc(greet(account)))
        + p(`Thank you for submitting ${esc(what)}. Every request is reviewed before access is granted.`)
        + p("We&rsquo;ll email you at this address once a decision has been made. No action is needed in the meantime."),
    }),
  };
}

// ---------- 2. admin: new request (never identity values) ----------

function requestRows(account) {
  const rows = [
    ['Type', ACCOUNT_TYPES[account.account_type]],
    ['Name', `${account.first_name} ${account.last_name}`],
    ['Email', account.email],
    ['Phone', account.phone],
    ['Title', account.job_title],
  ];
  if (account.account_type === 'company' || account.account_type === 'merchant') {
    rows.push(
      [account.account_type === 'company' ? 'Company' : 'Business', account.business_legal_name],
      ['DBA', account.business_dba],
      ['Company type', COMPANY_TYPES[account.company_type]],
      ['Website', account.website],
      ['State', STATES[account.state_of_registration]],
    );
  }
  if (account.account_type === 'individual') {
    rows.push(['Company', account.current_company], ['Role', WORKER_TYPES[account.worker_type]]);
  }
  if (account.identity_method) {
    rows.push(['Identity', account.identity_method === 'ein' ? 'EIN on file' : 'DOB and SSN last 4 on file']);
  }
  return rows.filter(([, v]) => v);
}

function adminNewRequest(account) {
  const url = `${baseUrl()}/admin/accounts/${account.id}`;
  const who = account.business_legal_name || `${account.first_name} ${account.last_name}`;
  const subject = `New FinDex request: ${ACCOUNT_TYPES[account.account_type]}, ${who}`;
  const rows = requestRows(account);
  const table = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;border-collapse:collapse;font-size:14px;">${
    rows.map(([k, v]) => `<tr><td style="padding:7px 12px 7px 0;color:#7a6c92;white-space:nowrap;vertical-align:top;border-bottom:1px solid #f1e7fc;">${esc(k)}</td><td style="padding:7px 0;color:#1c0f2e;border-bottom:1px solid #f1e7fc;">${esc(v)}</td></tr>`).join('')
  }</table>`;
  return {
    subject,
    text: textLayout(['A new FinDex access request is waiting for review.', '', ...rows.map(([k, v]) => `${k}: ${v}`), '', `Review: ${url}`]),
    html: htmlLayout({
      preheader: `${ACCOUNT_TYPES[account.account_type]} request from ${who}`,
      heading: 'New access request',
      bodyHtml: p('A new FinDex access request is waiting for review.') + table + button(url, 'Review request'),
    }),
  };
}

// ---------- 2b. admin: sign-in activity (never identity values) ----------

const ACTIVITY = {
  login: { subject: 'Signed in', intro: 'An approved account signed in to FinDex.' },
  pending: { subject: 'Sign-in attempt (pending request)', intro: 'Someone tried to sign in with an email whose request is still under review. They were emailed that it is still pending.' },
  none: { subject: 'Sign-in attempt (no account)', intro: 'Someone tried to sign in with an email that has no approved FinDex account. They were emailed the Request Access and Check My Record links.' },
};

function adminActivity(kind, { email, account }) {
  const a = ACTIVITY[kind];
  const when = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Los_Angeles' }) + ' PT';
  const rows = [['Email', email], ['When', when]];
  if (account) {
    rows.splice(1, 0, ['Name', `${account.first_name} ${account.last_name}`], ['Type', ACCOUNT_TYPES[account.account_type]]);
    if (account.business_legal_name) rows.splice(3, 0, ['Business', account.business_legal_name]);
  }
  const url = account ? `${baseUrl()}/admin/accounts/${account.id}` : null;
  const table = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;border-collapse:collapse;font-size:14px;">${
    rows.map(([k, v]) => `<tr><td style="padding:7px 12px 7px 0;color:#7a6c92;white-space:nowrap;border-bottom:1px solid #f1e7fc;">${esc(k)}</td><td style="padding:7px 0;color:#1c0f2e;border-bottom:1px solid #f1e7fc;">${esc(v)}</td></tr>`).join('')
  }</table>`;
  const off = 'To stop these emails, set ADMIN_ACTIVITY_EMAILS=false in Render.';
  return {
    subject: `FinDex: ${a.subject}, ${email}`,
    text: textLayout([a.intro, '', ...rows.map(([k, v]) => `${k}: ${v}`), ...(url ? ['', `View account: ${url}`] : []), '', off]),
    html: htmlLayout({
      preheader: `${a.subject}: ${email}`,
      heading: a.subject,
      bodyHtml: p(esc(a.intro)) + table + (url ? button(url, 'View account') : '')
        + `<p style="margin:0 0 8px;font-size:12px;color:#7a6c92;">${esc(off)}</p>`,
    }),
  };
}

// ---------- 3. sign-in code ----------

function signInCode(account, code) {
  const subject = `Your FinDex sign-in code: ${code}`;
  return {
    subject,
    text: textLayout([
      `Your FinDex sign-in code is: ${code}`,
      '',
      'It expires in 10 minutes and can be used once.',
      "If you didn't try to sign in, you can ignore this email.",
    ]),
    html: htmlLayout({
      preheader: `Your code is ${code}. It expires in 10 minutes.`,
      heading: 'Your sign-in code',
      bodyHtml: p('Enter this code to sign in to FinDex:')
        + `<p style="margin:0 0 20px;font-size:34px;font-weight:700;letter-spacing:8px;color:#1c0f2e;font-family:'SFMono-Regular',Menlo,Consolas,monospace;">${esc(code)}</p>`
        + p('It expires in 10 minutes and can be used once.')
        + p("If you didn&rsquo;t try to sign in, you can ignore this email."),
    }),
  };
}

// ---------- 3b. sign-in attempt: request still pending ----------

function signInPending(account) {
  return {
    subject: 'Your FinDex request is still under review',
    text: textLayout([
      greet(account),
      '',
      'You tried to sign in to FinDex, but your access request is still under review.',
      '',
      "We'll email you as soon as a decision has been made. No action is needed in the meantime.",
    ]),
    html: htmlLayout({
      preheader: 'Your access request is still under review.',
      heading: 'Still under review',
      bodyHtml: p(esc(greet(account)))
        + p('You tried to sign in to FinDex, but your access request is still under review.')
        + p('We&rsquo;ll email you as soon as a decision has been made. No action is needed in the meantime.'),
    }),
  };
}

// ---------- 3c. sign-in attempt: no approved account for this email ----------

function signInNoAccount() {
  const requestUrl = `${baseUrl()}/request-access`;
  const recordUrl = `${baseUrl()}/check-my-record`;
  return {
    subject: 'Your FinDex sign-in',
    text: textLayout([
      'Someone tried to sign in to FinDex with this email address, but there is no approved FinDex account for it.',
      '',
      `Companies that want to search and report: ${requestUrl}`,
      `Individuals and businesses checking their own record: ${recordUrl}`,
      '',
      "If this wasn't you, you can ignore this email.",
    ]),
    html: htmlLayout({
      preheader: 'There is no approved FinDex account for this email address.',
      heading: 'No account found',
      bodyHtml: p('Someone tried to sign in to FinDex with this email address, but there is no approved FinDex account for it.')
        + p(`<strong>Companies</strong> that want to search and report: <a href="${esc(requestUrl)}" style="color:#3d0f7a;">Request Access</a>`)
        + p(`<strong>Individuals and businesses</strong> checking their own record: <a href="${esc(recordUrl)}" style="color:#3d0f7a;">Check My Record</a>`)
        + p('If this wasn&rsquo;t you, you can ignore this email.'),
    }),
  };
}

// ---------- 4. approved ----------

function approved(account) {
  const url = `${baseUrl()}/login`;
  return {
    subject: "You're approved for FinDex",
    text: textLayout([
      greet(account),
      '',
      'Your FinDex access request has been approved.',
      '',
      `Sign in here: ${url}`,
      '',
      "FinDex doesn't use passwords. Enter your email and we'll send you a one-time sign-in code each time.",
    ]),
    html: htmlLayout({
      preheader: 'Your FinDex access request has been approved.',
      heading: "You're approved",
      bodyHtml: p(esc(greet(account)))
        + p('Your FinDex access request has been approved.')
        + button(url, 'Sign in to FinDex')
        + p("FinDex doesn&rsquo;t use passwords. Enter your email and we&rsquo;ll send you a one-time sign-in code each time."),
    }),
  };
}

// ---------- 5. denied ----------

function denied(account) {
  return {
    subject: 'Your FinDex request',
    text: textLayout([
      greet(account),
      '',
      'Thank you for your interest in FinDex. After review, we are unable to approve your access request at this time.',
      '',
      'If you believe this was in error or your information has changed, you are welcome to reply to this email.',
    ]),
    html: htmlLayout({
      preheader: 'An update on your FinDex access request.',
      heading: 'An update on your request',
      bodyHtml: p(esc(greet(account)))
        + p('Thank you for your interest in FinDex. After review, we are unable to approve your access request at this time.')
        + p('If you believe this was in error or your information has changed, you are welcome to reply to this email.'),
    }),
  };
}

module.exports = { sendEmail, templates: { underReview, adminNewRequest, adminActivity, signInCode, signInPending, signInNoAccount, approved, denied }, requestRows };
