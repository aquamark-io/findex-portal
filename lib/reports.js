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

// "What we need to see": one list per category (who, what, when), shown on the report form AND used as the AI
// review checklist. GUIDANCE adds category-specific notes shown under the list and given to the AI.
const REQUIREMENTS = {
  missed_payments: ['The merchant\u2019s legal name or EIN', 'A screenshot from your payment system showing the missed or returned payment and its amount', 'The payment date'],
  default: ['The merchant\u2019s legal name or EIN', 'A screenshot from your payment system showing the missed payments and the open balance', 'The default notice you sent the merchant, with its date'],
  fraud: ['The reported party\u2019s name, email, or account', 'The manipulated document, image, or data', 'A date'],
  impersonation: ['The reported party\u2019s name, email, phone number, or account', 'The impersonation (e.g. emails, messages, or documents using someone else\u2019s name or identity)', 'A date'],
  data_theft: ['The reported party\u2019s name, email, or login', 'Proof the data or deal was sent outside your business (e.g. an email showing attachments sent to an outside address, or an export log)', 'A date'],
  merchant_deception: ['The reported party\u2019s name, email, or phone number', 'The misleading message or statement, and who it was made to (e.g. a merchant or partner)', 'A date'],
  data_mishandling: ['The partner\u2019s name, domain, or email', 'Your data being shared, exposed, or used without permission (e.g. a vendor\u2019s breach notification, emails, or a phone call)', 'A date'],
};

const GUIDANCE = {
  missed_payments: 'A missed payment is reportable even if it was made up later. Payments you agreed to adjust (e.g. an approved reconciliation) were not due.',
  default: 'The default date is the date you formally declared the default.',
  fraud: 'In the description, explain what was manipulated and why you believe this party did it. Supporting documents help: email correspondence, fraud-detection tool results, or the original next to the altered file.',
  impersonation: 'In the description, explain who was impersonated and how you know (e.g. the real person or business confirmed it wasn\u2019t them). This includes identity theft used to obtain funding. Do not upload full SSNs or ID numbers.',
  data_theft: 'Don\u2019t upload the data itself, only proof that it was sent out.',
  merchant_deception: 'For phone calls, include the call log and the transcript or recording exported from your phone system (not a typed document), plus proof linking the reported party to their number (e.g. their user profile) and the other caller\u2019s number to the business (e.g. a CRM screenshot or directory listing). Calls must have been lawfully recorded.',
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
  canReportRepayment, SUBJECT_TYPES, SUBJECT_SLUG, SLUG_FOR, CATEGORIES, REQUIREMENTS, GUIDANCE, REPAYMENT_FIELDS, fmtMoney, categoriesFor,
  MAX_FILES, MAX_FILE_BYTES, ACCEPT_ATTR, fileType, safeName, sha256, fmtSize, parseWebsite,
};
