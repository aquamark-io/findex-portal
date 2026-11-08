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
  missed_payments:    { label: 'Missed payments', subjects: ['merchant'], fundersOnly: true },
  default:            { label: 'Default', subjects: ['merchant'], fundersOnly: true, needsDefaultNotice: true },
};

// Repayment reports (missed payments, defaults) also capture the amount: the missed payment, or the open balance.
const REPAYMENT_FIELDS = {
  missed_payments: { dateLabel: 'Payment date', amountLabel: 'Payment amount' },
  default: { dateLabel: 'Default date', amountLabel: 'Open balance' },
};
const fmtMoney = (n) => (n == null || n === '' ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// Each requirement is either plain text or [label, text] (shown as "label: text").
const reqLabel = (r) => (Array.isArray(r) ? r[0] : r);
const reqText = (r) => (Array.isArray(r) ? `${r[0]}: ${r[1]}` : r);

// "What we need to see": one list per category (who, what, when), shown on the report form AND used as the AI
// review checklist. GUIDANCE adds category-specific notes shown under the list and given to the AI.
const REQUIREMENTS = {
  missed_payments: [
    ['Merchant identity', 'Business name or EIN.'],
    ['Missed payment', 'A screenshot from your payment system showing the missed or returned payment, and its amount.'],
    ['Payment date', 'The date the payment was due, attempted, or bounced.'],
  ],
  default: [
    ['Default notice', 'A copy of the formal default notice identifying the merchant and the date of default.'],
    ['Proof of delivery', 'Evidence that the notice was sent to the merchant, such as a sent email, delivery confirmation, or system-generated notification log.'],
  ],
  fraud: [
    ['The reported party\u2019s identity', 'Name, email address, or other identifying information.'],
    ['The document manipulation', 'Evidence showing what was altered or falsified.'],
    ['Connection to the reported party', 'Evidence linking the individual to the manipulation or submission of the altered document.'],
  ],
  impersonation: [
    ['The reported party\u2019s identity', 'Name, email address, phone number, or other identifying information.'],
    ['The impersonation', 'Communication or activity showing someone falsely representing themselves as another person or company.'],
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
  data_mishandling: ['The partner\u2019s name, domain, or email', 'Your data being shared, exposed, or used without permission (e.g. a vendor\u2019s breach notification, emails, or a phone call)', 'A date'],
};

const GUIDANCE = {
  missed_payments: 'A missed or returned payment may be reported even if the merchant catches up later. The reporting funder or lender may remove the report at their discretion.',
  default: 'The default date is the date your company formally declared the merchant in default, not the date of the first missed payment.',
  fraud: 'Explain what was altered and why you believe the reported party is responsible. Supporting evidence may include email correspondence, fraud-detection results, or original and altered versions of the document for comparison.',
  impersonation: 'Explain who was impersonated, how the impersonation occurred, and why you believe the reported party is responsible. Supporting evidence may include emails, messages, call recordings, phone system records, or other documentation. Do not upload full SSNs or government-issued ID numbers.',
  data_theft: 'Explain what information was shared, where it was sent, and why you believe the reported individual was responsible. Do not upload the sensitive data itself, only evidence of its unauthorized disclosure.',
  merchant_deception: 'Explain what misleading information was communicated, who received it, and why you believe the reported individual was responsible. Supporting evidence may include emails, messages, or recorded phone calls.\n\nFor phone calls, provide the call log and recording or transcript exported directly from your phone system (not a manually typed document). Include evidence linking the reported individual to their phone number and the recipient\u2019s number to the merchant or business, such as user profiles, CRM records, or directory listings. Calls must have been lawfully recorded.',
  data_mishandling: 'For phone calls, include the call log and the transcript or recording exported from your phone system (not a typed document), plus proof linking the reported party to their number (e.g. their user profile) and the other caller\u2019s number to the business (e.g. a CRM screenshot or directory listing). Calls must have been lawfully recorded.',
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

module.exports = {
  canReportRepayment, SUBJECT_TYPES, SUBJECT_SLUG, SLUG_FOR, CATEGORIES, REQUIREMENTS, reqLabel, reqText, GUIDANCE, REPAYMENT_FIELDS, fmtMoney, categoriesFor,
  MAX_FILES, MAX_FILE_BYTES, ACCEPT_ATTR, fileType, safeName, sha256, fmtSize, parseWebsite,
};
