/**
 * Report rules shared by the member form, admin, and (later) the API.
 *   - which categories apply to which subject type, and which need a funder
 *   - subject validation and normalization (identifiers encrypted by the caller)
 *   - evidence file limits
 */
const crypto = require('crypto');
const { parseWebsite } = require('./validate');

const SUBJECT_TYPES = { individual: 'Individual', company: 'Partner', merchant: 'Funded Business' };
const SUBJECT_SLUG = { individual: 'individual', partner: 'company', 'funded-business': 'merchant' };
const SLUG_FOR = { individual: 'individual', company: 'partner', merchant: 'funded-business' };

const CATEGORIES = {
  data_theft:         { label: 'Data theft or backdooring', subjects: ['individual', 'company'] },
  merchant_deception: { label: 'Deception', subjects: ['individual', 'company'] },
  fraud:              { label: 'Document fraud', subjects: ['individual', 'merchant'] },
  impersonation:      { label: 'Impersonation', subjects: ['individual', 'company', 'merchant'] },
  data_mishandling:   { label: 'Data mishandling', subjects: ['company'] },
  missed_payments:    { label: 'Payment delinquency', subjects: ['merchant'], fundersOnly: true },
  default:            { label: 'Default', subjects: ['merchant'], fundersOnly: true, needsDefaultNotice: true },
};

// Repayment reports (missed payments, defaults) also capture the amount: the missed payment, or the open balance.
const REPAYMENT_FIELDS = {
  missed_payments: { dateLabel: 'Delinquency date', amountLabel: 'Past-due amount', delinquency: true },
  default: { dateLabel: 'Default date' },
};
// Payment delinquency: one or more missed payments, reported at the funder's or lender's discretion, once per delinquency (not per payment).
const MIN_MISSED_PAYMENTS = 1;
const FREQUENCIES = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
const fmtDateOnly = (d) => (d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
// "Delinquent as of Nov 8, 2026" or "Caught up on Nov 1, 2026" (null for other categories).
// The status always carries its date, so a report that is never updated still states an accurate fact.
const delinquencyText = (r) => (!r || !r.delinquency_status ? null : r.delinquency_status === 'caught_up' ? `Caught up${r.caught_up_on ? ' on ' + fmtDateOnly(r.caught_up_on) : ''}` : `Delinquent${r.delinquency_as_of ? ' as of ' + fmtDateOnly(r.delinquency_as_of) : ''}`);
const fmtMoney = (n) => (n == null || n === '' ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// Each requirement is either plain text or [label, text] (shown as "label: text").
const reqLabel = (r) => (Array.isArray(r) ? r[0] : r);
const reqText = (r) => (Array.isArray(r) ? `${r[0]}: ${r[1]}` : r);

// "What we need to see": one list per category (who, what, when), shown on the report form AND used as the AI
// review checklist. GUIDANCE adds category-specific notes shown under the list and given to the AI.
const REQUIREMENTS = {
  missed_payments: [
    ['Merchant identity', 'Business name or EIN.'],
    ['Missed payments', 'A screenshot from your payment system showing the missed or returned payment(s) and the past-due amount.'],
    ['Delinquency date', 'The date of the first missed or returned payment.'],
  ],
  default: [
    ['Default notice', 'A copy of the formal default notice identifying the merchant and the date of default.'],
    ['Proof of delivery', 'Evidence that the notice was sent to the merchant, such as a sent email, delivery confirmation, or system-generated notification log.'],
  ],
  fraud: [
    ['The reported party\u2019s identity', 'Name, email address, or other identifying information.'],
    ['Document manipulation', 'Evidence showing what was altered or falsified.'],
    ['Connection to the reported party', 'Evidence linking the reported party to the manipulation or submission of the altered document.'],
  ],
  impersonation: [
    ['The reported party\u2019s identity', 'Name, email address, phone number, or other identifying information.'],
    ['Impersonation', 'Communication or activity showing someone falsely representing themselves as another person or company.'],
  ],
  data_theft: [
    ['Reported individual', 'Name, email address, or system login.'],
    ['Unauthorized sharing', 'Evidence showing company or merchant information was sent outside your organization, such as an email with attachments sent to an external address, file transfer records, or export logs.'],
    ['Date', 'When the incident occurred.'],
  ],
  merchant_deception: [
    ['Reported individual', 'Name, email address, or phone number.'],
    ['Deception', 'The misleading statement or communication and who received it.'],
    ['Date', 'When the incident occurred.'],
  ],
  data_mishandling: [
    ['Reported company', 'Business name, domain, or email address.'],
    ['Data mishandling', 'Evidence showing your data was accessed, shared, exposed, or used without authorization.'],
    ['Date', 'When the incident occurred or was discovered.'],
  ],
};

const GUIDANCE = {
  missed_payments: 'A payment delinquency is one or more missed or returned payments, reported at the discretion of the funder or lender. Report it once, as a single event, rather than each missed payment.\n\nUpdates are optional. If the merchant later catches up or pays off the balance, we recommend updating the report to show it: it\u2019s the fair thing to do. You can also remove the report at your discretion. To provide transparency about how current the information is, FinDex displays the status with the date it was reported or last updated (for example, \u201cDelinquent as of Nov 8, 2026\u201d).',
  default: 'The default date is the date your company formally declared the merchant in default, not the date of the first missed payment.',
  fraud: 'Explain what was altered and why you believe the reported party is responsible. Supporting evidence may include email correspondence, fraud-detection results, or original and altered versions of the document for comparison.',
  impersonation: 'Explain who was impersonated, how the impersonation occurred, and why you believe the reported party is responsible. Supporting evidence may include emails, messages, call recordings, phone system records, or other documentation. Do not upload full SSNs or government-issued ID numbers.',
  data_theft: 'Explain what information was shared, where it was sent, and why you believe the reported individual was responsible. Do not upload the sensitive data itself, only evidence of its unauthorized disclosure.',
  merchant_deception: 'Explain what misleading information was communicated, who received it, and why you believe the reported individual was responsible. Supporting evidence may include emails, messages, or recorded phone calls.\n\nFor phone calls, provide the call log and recording or transcript exported directly from your phone system (not a manually typed document). Include evidence linking the reported individual to their phone number and the recipient\u2019s number to the merchant or business, such as user profiles, CRM records, or directory listings. Calls must have been lawfully recorded.',
  data_mishandling: 'Explain how the partner or vendor mishandled your data and why you believe they were responsible. Supporting evidence may include emails, messages, breach notifications, access logs, or recorded phone calls. Do not upload the sensitive data itself.\n\nFor phone calls, provide the call log and recording or transcript exported directly from your phone system (not a manually typed document), along with evidence linking the phone numbers to the parties involved. Calls must have been lawfully recorded.',
};

// Repayment categories (missed payments, default) are for funders and lenders.
const REPAYMENT_REPORTERS = ['funder', 'lender'];
const canReportRepayment = account => REPAYMENT_REPORTERS.includes(account.company_type);

function categoriesFor(subjectType, account) {
  const isFunder = canReportRepayment(account);
  return Object.entries(CATEGORIES)
    .filter(([, c]) => c.subjects.includes(subjectType) && (!c.fundersOnly || isFunder))
    .map(([key, c]) => ({ key, ...c }));
}

const MAX_FILES = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = {
  'application/pdf': ['.pdf'],
  'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/heic': ['.heic'], 'image/webp': ['.webp'],
  'message/rfc822': ['.eml'], 'application/vnd.ms-outlook': ['.msg'],
  'text/csv': ['.csv'], 'application/vnd.ms-excel': ['.xls', '.csv'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'audio/mpeg': ['.mp3'], 'audio/mp4': ['.m4a'], 'audio/x-m4a': ['.m4a'], 'audio/wav': ['.wav'],
};
const EXT_TO_TYPE = {};
for (const [type, exts] of Object.entries(ALLOWED_TYPES)) for (const e of exts) if (!EXT_TO_TYPE[e]) EXT_TO_TYPE[e] = type;
const ACCEPT_ATTR = Object.keys(EXT_TO_TYPE).join(',');

// Browsers often send .eml/.msg/.heic as application/octet-stream: fall back to the extension.
function fileType(file) {
  const ext = (file.originalname.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  if (ALLOWED_TYPES[file.mimetype] && ALLOWED_TYPES[file.mimetype].includes(ext)) return file.mimetype;
  return EXT_TO_TYPE[ext] || null;
}

function safeName(name) {
  return String(name).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';
}

const fmtSize = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// Partner (company) wording for categories also offered for individuals.
const COMPANY_REQUIREMENTS = {
  data_theft: [
    ['Reported company', 'Business name, domain, or email address.'],
    REQUIREMENTS.data_theft[1],
    REQUIREMENTS.data_theft[2],
  ],
  merchant_deception: [
    ['Reported company', 'Business name, domain, email address, or phone number.'],
    REQUIREMENTS.merchant_deception[1],
    REQUIREMENTS.merchant_deception[2],
  ],
};
const COMPANY_GUIDANCE = {
  data_theft: GUIDANCE.data_theft.replace('reported individual', 'reported company'),
  merchant_deception: GUIDANCE.merchant_deception.replace(/reported individual/g, 'reported company'),
};
// The first checklist item names the reported party the same way on each form.
const PARTY_LABEL = { individual: 'Reported individual', company: 'Reported company', merchant: 'Reported merchant' };
const PARTY_TEXT = { company: 'Business name, domain, email address, or phone number.', merchant: 'Business name, EIN, email address, or phone number.' };
const GENERIC_PARTY = ['The reported party\u2019s identity', 'Merchant identity'];
const requirementsFor = (category, subjectType) => {
  const list = (subjectType === 'company' && COMPANY_REQUIREMENTS[category]) || REQUIREMENTS[category] || [];
  return list.map(item => {
    if (!Array.isArray(item) || !GENERIC_PARTY.includes(item[0]) || !PARTY_LABEL[subjectType]) return item;
    // Generic identity wording (Document fraud, Impersonation) gets the form's own; Missed payments keeps "Business name or EIN".
    const text = item[0] === 'Merchant identity' ? item[1] : (PARTY_TEXT[subjectType] || item[1]);
    return [PARTY_LABEL[subjectType], text];
  });
};
const guidanceFor = (category, subjectType) => (subjectType === 'company' && COMPANY_GUIDANCE[category]) || GUIDANCE[category] || '';

module.exports = {
  canReportRepayment, SUBJECT_TYPES, SUBJECT_SLUG, SLUG_FOR, CATEGORIES, REQUIREMENTS, requirementsFor, guidanceFor, reqLabel, reqText, GUIDANCE, REPAYMENT_FIELDS, fmtMoney, MIN_MISSED_PAYMENTS, FREQUENCIES, delinquencyText, categoriesFor,
  MAX_FILES, MAX_FILE_BYTES, ACCEPT_ATTR, fileType, safeName, sha256, fmtSize, parseWebsite,
};
