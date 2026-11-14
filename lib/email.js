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
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`Postmark ${res.status}: ${body.slice(0, 300)}`);
    try { err.postmarkCode = JSON.parse(body).ErrorCode; } catch { /* not JSON */ }
    throw err;
  }
  try { return JSON.parse(body); } catch { return {}; } // { MessageID, ... }
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

// +14155551212 -> (415) 555-1212; other formats unchanged.
const fmtPhone = v => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(v || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : v;
};

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
    ['Phone', fmtPhone(account.phone)],
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
  const testTag = account.is_test ? '[TEST] ' : '';
  const url = `${baseUrl()}/admin/accounts/${account.id}`;
  const who = account.business_legal_name || `${account.first_name} ${account.last_name}`;
  const subject = `${account.is_test && !/^\[test\]/i.test(who) ? testTag : ''}New FinDex request: ${ACCOUNT_TYPES[account.account_type]}, ${who}`;
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

// ---------- 3d. duplicate sign-up: this email already has an account ----------

function alreadyHaveAccount(account) {
  const url = `${baseUrl()}/login`;
  return {
    subject: 'You already have a FinDex account',
    text: textLayout([
      greet(account),
      '',
      'We received a new FinDex access request from this email address, but you already have an approved account, so no new request was created.',
      '',
      `Sign in here: ${url}`,
      '',
      "If this wasn't you, you can ignore this email.",
    ]),
    html: htmlLayout({
      preheader: 'You already have an approved FinDex account.',
      heading: 'You already have an account',
      bodyHtml: p(esc(greet(account)))
        + p('We received a new FinDex access request from this email address, but you already have an approved account, so no new request was created.')
        + button(url, 'Sign in to FinDex')
        + p('If this wasn&rsquo;t you, you can ignore this email.'),
    }),
  };
}

function requestAlreadyPending(account) {
  return {
    subject: 'Your FinDex request is still under review',
    text: textLayout([
      greet(account),
      '',
      'We received another FinDex access request from this email address. Your original request is still under review, so no new request was created.',
      '',
      "We'll email you as soon as a decision has been made. No action is needed in the meantime.",
    ]),
    html: htmlLayout({
      preheader: 'Your original request is still under review.',
      heading: 'Still under review',
      bodyHtml: p(esc(greet(account)))
        + p('We received another FinDex access request from this email address. Your original request is still under review, so no new request was created.')
        + p('We&rsquo;ll email you as soon as a decision has been made. No action is needed in the meantime.'),
    }),
  };
}

// ---------- reports (phase two) ----------

const kv = rows => `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;border-collapse:collapse;font-size:14px;">${
  rows.map(([k, v]) => `<tr><td style="padding:7px 12px 7px 0;color:#7a6c92;white-space:nowrap;vertical-align:top;border-bottom:1px solid #f1e7fc;">${esc(k)}</td><td style="padding:7px 0;color:#1c0f2e;border-bottom:1px solid #f1e7fc;">${esc(v)}</td></tr>`).join('')
}</table>`;

// info: { reportId, subjectLabel, subjectName, categoryLabel, incidentDate, fileCount }
function reportReceived(account, info) {
  const url = `${baseUrl()}/reports/${info.reportId}`;
  const rows = [['About', `${info.subjectName} (${info.subjectLabel})`], ['Category', info.categoryLabel], [info.dateLabel || 'Incident date', info.incidentDate], ['Files', String(info.fileCount)]];
  return {
    subject: 'Your FinDex report was received',
    text: textLayout([greet(account), '', 'We received your report. Every report is independently reviewed before anything is sent or published.', '',
      ...rows.map(([k, v]) => `${k}: ${v}`), '', `View report: ${url}`]),
    html: htmlLayout({
      preheader: 'Your report is waiting for review.',
      heading: 'Report received',
      bodyHtml: p(esc(greet(account))) + p('We received your report. Every report is independently reviewed before anything is sent or published.') + kv(rows) + button(url, 'View report'),
    }),
  };
}

function adminNewReport(reporter, info) {
  const url = `${baseUrl()}/admin/reports/${info.reportId}`;
  const rows = [['Reported by', `${reporter.business_legal_name} (${COMPANY_TYPES[reporter.company_type] || 'Company'})`], ['About', `${info.subjectName} (${info.subjectLabel})`],
    ['Category', info.categoryLabel], [info.dateLabel || 'Incident date', info.incidentDate], ['Files', String(info.fileCount)]];
  return {
    subject: `${info.isTest ? '[TEST] ' : ''}New FinDex report: ${info.categoryLabel}, ${info.subjectName}`,
    text: textLayout(['A new report is waiting for review.', '', ...rows.map(([k, v]) => `${k}: ${v}`), '', `Review: ${url}`]),
    html: htmlLayout({ preheader: `${info.categoryLabel} report about ${info.subjectName}`, heading: 'New report to review', bodyHtml: p('A new report is waiting for review.') + kv(rows) + button(url, 'Review report') }),
  };
}

function reportRejected(account, info, reason) {
  const url = `${baseUrl()}/reports/${info.reportId}`;
  return {
    subject: 'An update on your FinDex report',
    text: textLayout([greet(account), '', `After review, your ${info.categoryLabel.toLowerCase()} report about ${info.subjectName} was not accepted.`, '', `Reason: ${reason}`, '',
      'You are welcome to submit a new report with additional evidence.', '', `View report: ${url}`]),
    html: htmlLayout({
      preheader: 'Your report was not accepted.',
      heading: 'Report not accepted',
      bodyHtml: p(esc(greet(account))) + p(`After review, your ${esc(info.categoryLabel.toLowerCase())} report about ${esc(info.subjectName)} was not accepted.`)
        + p(`<strong>Reason:</strong> ${esc(reason)}`) + p('You are welcome to submit a new report with additional evidence.') + button(url, 'View report'),
    }),
  };
}

// ---------- notices (phase two, step 2) ----------

// Official CFPB "A Summary of Your Rights Under the Fair Credit Reporting Act" (Regulation V, Appendix K).
const CFPB_SUMMARY_URL = 'https://www.consumerfinance.gov/rules-policy/regulations/1022/k/';

const SLUGS = { individual: 'individual', company: 'company', merchant: 'funded-business' };

// To the reported party. info: { subjectType, subjectName, reporterName, categoryLabel, incidentDate, description, publishDate }
function noticeToSubject(info) {
  const signup = `${baseUrl()}/check-my-record/${SLUGS[info.subjectType]}`;
  const login = `${baseUrl()}/login`;
  const rights = info.subjectType === 'individual';
  const rows = [['Reported by', info.reporterName], ['Category', info.categoryLabel], [info.dateLabel || 'Incident date', info.incidentDate], ['Publishes on', info.publishDate]];
  const text = [
    `Hello${info.subjectName ? ` ${info.subjectName}` : ''},`,
    '',
    `${info.reporterName} has submitted a report about you to FinDex, an evidence-based reporting database for FinTech. FinDex reviewed the supporting evidence before sending this notice.`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(info.description ? ['', `Description: ${info.description}`] : []),
    '',
    `You have 10 days to respond before this report is published. To view the report and its evidence, create a free account (${signup}) or sign in if you already have one (${login}).`,
    '',
    'To dispute this report, sign in and choose Dispute, or reply to this email. Disputed reports are withheld while we review the evidence.',
    ...(rights ? ['', `Your rights under the Fair Credit Reporting Act: ${CFPB_SUMMARY_URL}`] : []),
  ];
  return {
    subject: `Notice: a report about you was submitted to FinDex by ${info.reporterName}`,
    text: textLayout(text),
    html: htmlLayout({
      preheader: `You have 10 days to respond before this report is published.`,
      heading: 'A report about you was submitted',
      bodyHtml: p(`Hello${info.subjectName ? ` ${esc(info.subjectName)}` : ''},`)
        + p(`<strong>${esc(info.reporterName)}</strong> has submitted a report about you to FinDex, an evidence-based reporting database for FinTech. FinDex reviewed the supporting evidence before sending this notice.`)
        + kv(rows)
        + (info.description ? p(`<strong>Description:</strong> ${esc(info.description)}`) : '')
        + p('You have <strong>10 days</strong> to respond before this report is published. To view the report and its evidence, create a free account or sign in.')
        + button(signup, 'View the report')
        + p(`Already have an account? <a href="${esc(login)}" style="color:#3d0f7a;">Sign in</a>.`)
        + p('To dispute this report, sign in and choose <strong>Dispute</strong>, or reply to this email. Disputed reports are withheld while we review the evidence.')
        + (rights ? p(`<a href="${CFPB_SUMMARY_URL}" style="color:#3d0f7a;">A Summary of Your Rights Under the Fair Credit Reporting Act</a> (Consumer Financial Protection Bureau)`) : ''),
    }),
  };
}

// To the reporter. info: { reportId, subjectName, categoryLabel, publishDate, reason }
function reportAccepted(account, info) {
  const url = `${baseUrl()}/reports/${info.reportId}`;
  return {
    subject: 'Your FinDex report was accepted',
    text: textLayout([greet(account), '', `Your ${info.categoryLabel.toLowerCase()} report about ${info.subjectName} was accepted after review. We have notified them, and they have 10 days to respond.`, '',
      `If it is not disputed, it will be published on ${info.publishDate}.`, '', `View report: ${url}`]),
    html: htmlLayout({ preheader: 'Your report was accepted and the reported party was notified.', heading: 'Report accepted',
      bodyHtml: p(esc(greet(account))) + p(`Your ${esc(info.categoryLabel.toLowerCase())} report about ${esc(info.subjectName)} was accepted after review. We have notified them, and they have 10 days to respond.`)
        + p(`If it is not disputed, it will be published on <strong>${esc(info.publishDate)}</strong>.`) + button(url, 'View report') }),
  };
}

function noticeUndeliverable(account, info) {
  const url = `${baseUrl()}/reports/${info.reportId}`;
  return {
    subject: 'Action needed: we could not deliver your FinDex notice',
    text: textLayout([greet(account), '', `We could not deliver the notice for your report about ${info.subjectName} to ${info.email}. The report is paused and can't be published until they are notified.`, '',
      `Please provide another email address: ${url}`]),
    html: htmlLayout({ preheader: 'Please provide another email address.', heading: 'Notice could not be delivered',
      bodyHtml: p(esc(greet(account))) + p(`We could not deliver the notice for your report about ${esc(info.subjectName)} to <strong>${esc(info.email)}</strong>. The report is paused and can\u2019t be published until they are notified.`)
        + p('Please provide another email address.') + button(url, 'Add another email') }),
  };
}

function reportPublished(account, info) {
  const url = `${baseUrl()}/reports/${info.reportId}`;
  return {
    subject: 'Your FinDex report was published',
    text: textLayout([greet(account), '', `Your ${info.categoryLabel.toLowerCase()} report about ${info.subjectName} was not disputed within 10 days and is now published.`, '', `View report: ${url}`]),
    html: htmlLayout({ preheader: 'Your report is now published.', heading: 'Report published',
      bodyHtml: p(esc(greet(account))) + p(`Your ${esc(info.categoryLabel.toLowerCase())} report about ${esc(info.subjectName)} was not disputed within 10 days and is now published.`) + button(url, 'View report') }),
  };
}

// ---------- disputes (phase two, step 4) ----------

// Generic short email: { subject, heading, lines: [text...], url, cta, preheader }
function simple({ subject, heading, lines, url, cta, preheader }) {
  return {
    subject,
    text: textLayout([...lines.flatMap(l => [l, '']), ...(url ? [`${cta}: ${url}`] : [])]),
    html: htmlLayout({ preheader: preheader || lines[0], heading, bodyHtml: lines.map(l => p(esc(l))).join('') + (url ? button(url, cta) : '') }),
  };
}

const OUTCOME_TEXT = {
  upheld: 'The report was upheld and remains published.',
  amended: 'The report was amended and is published with the corrections.',
  removed: 'The report was removed and is no longer part of FinDex.',
};

const disputeEmails = {
  // info: { reportId, disputeId, subjectName, reporterName, categoryLabel, dueDate, outcome, note, isTest }
  toSubjectOpened: (account, i) => simple({
    subject: 'We received your FinDex dispute',
    heading: 'Dispute received',
    lines: [greet(account), `We received your dispute of the ${i.categoryLabel.toLowerCase()} report submitted by ${i.reporterName}. The report is withheld while we review the evidence from both sides.`,
      `We will complete our review by ${i.dueDate} and email you the outcome.`],
    url: `${baseUrl()}/dashboard`, cta: 'View your record',
  }),
  toReporterOpened: (account, i) => simple({
    subject: `Your FinDex report about ${i.subjectName} was disputed`,
    heading: 'Report disputed',
    lines: [greet(account), `${i.subjectName} disputed your ${i.categoryLabel.toLowerCase()} report. The report is withheld while we reinvestigate.`,
      'Please review the dispute and respond with any additional evidence as soon as possible. Unverifiable information is corrected or removed.',
      `Our review will be completed by ${i.dueDate}.`],
    url: `${baseUrl()}/reports/${i.reportId}`, cta: 'Review and respond',
  }),
  toAdminOpened: i => simple({
    subject: `${i.isTest ? '[TEST] ' : ''}FinDex: New dispute, ${i.subjectName}`,
    heading: 'New dispute', lines: [`${i.subjectName} disputed a ${i.categoryLabel.toLowerCase()} report from ${i.reporterName}. The report is withheld. Due ${i.dueDate}.`],
    url: `${baseUrl()}/admin/reports/${i.reportId}`, cta: 'Open dispute',
  }),
  toAdminResponded: i => simple({
    subject: `${i.isTest ? '[TEST] ' : ''}FinDex: Reporter responded to dispute, ${i.subjectName}`,
    heading: 'Reporter responded', lines: [`${i.reporterName} responded to the dispute about ${i.subjectName}. Due ${i.dueDate}.`],
    url: `${baseUrl()}/admin/reports/${i.reportId}`, cta: 'Open dispute',
  }),
  resolved: (account, i, toReporter) => simple({
    subject: 'Your FinDex dispute has been resolved',
    heading: 'Dispute resolved',
    lines: [greet(account), toReporter ? `The dispute of your ${i.categoryLabel.toLowerCase()} report about ${i.subjectName} has been reviewed.` : `Your dispute of the ${i.categoryLabel.toLowerCase()} report submitted by ${i.reporterName} has been reviewed.`,
      OUTCOME_TEXT[i.outcome], i.note],
    url: toReporter ? `${baseUrl()}/reports/${i.reportId}` : `${baseUrl()}/dashboard`, cta: toReporter ? 'View report' : 'View your record',
  }),
  // The reporting company removed its own report.
  removedToSubject: i => simple({
    subject: `A FinDex report about you was removed`,
    heading: 'Report removed',
    lines: [`Hello${i.subjectName ? ` ${i.subjectName}` : ''},`, `${i.reporterName} removed the ${i.categoryLabel.toLowerCase()} report it submitted about you. It is no longer part of FinDex and won\u2019t appear in any search.`],
    url: `${baseUrl()}/dashboard`, cta: 'View your record',
  }),
  contactToAdmin: i => simple({
    subject: `${i.isTest ? '[TEST] ' : ''}FinDex: New notice email from the reporter, ${i.subjectName}`,
    heading: 'New notice email',
    lines: [`${i.reporterName} gave a new email address (${i.email}) for the notice about ${i.subjectName}. ${i.sent ? 'The notice was sent and the 10 days started.' : 'That email could not be sent either.'}`],
    url: `${baseUrl()}/admin/reports/${i.reportId}`, cta: 'Open report',
  }),
  removedToAdmin: i => simple({
    subject: `${i.isTest ? '[TEST] ' : ''}FinDex: Report removed by the reporter, ${i.subjectName}`,
    heading: 'Report removed by the reporter',
    lines: [`${i.reporterName} removed its ${i.categoryLabel.toLowerCase()} report about ${i.subjectName}.${i.hadDispute ? ' The open dispute was closed.' : ''}`],
    url: `${baseUrl()}/admin/reports/${i.reportId}`, cta: 'Open report',
  }),
};

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

module.exports = { disputeEmails, CFPB_SUMMARY_URL, sendEmail, templates: { noticeToSubject, reportAccepted, noticeUndeliverable, reportPublished, reportReceived, adminNewReport, reportRejected, underReview, adminNewRequest, signInCode, signInPending, signInNoAccount, alreadyHaveAccount, requestAlreadyPending, approved, denied }, requestRows };
