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
  data_theft:         { label: 'Backdooring & data theft', subjects: ['individual', 'company'] },
  merchant_deception: { label: 'Deceiving merchants', subjects: ['individual', 'company'] },
  fraud:              { label: 'Fraud', subjects: ['individual', 'company', 'merchant'] },
  data_mishandling:   { label: 'Data mishandling', subjects: ['company'] },
  missed_payments:    { label: 'Missed payments', subjects: ['merchant'], fundersOnly: true },
  default:            { label: 'Default', subjects: ['merchant'], fundersOnly: true, needsDefaultNotice: true },
};

// "What we need to see": one list per category, used in the report form AND as the AI review checklist.
// Every report: who (the reported party), what (the incident itself), when (a date).
const REQUIREMENTS = {
  missed_payments: ['The merchant\u2019s name, EIN, or deal ID', 'The payment that was missed or returned (payment history export or screenshot)', 'The date of the missed payment'],
  default: ['The merchant\u2019s name, EIN, or deal ID', 'The missed payments (payment history)', 'The default notice you sent the merchant, with its date'],
  fraud: ['The reported party\u2019s name, email, or account', 'The altered document or data', 'A date'],
  data_theft: ['The reported party\u2019s name, email, or login', 'The data or deal being taken or sent outside your business (e.g. a forwarded email, export log)', 'A date'],
  merchant_deception: ['The reported party\u2019s name, email, or account', 'The misleading message or statement made to the merchant', 'A date'],
  data_mishandling: ['The partner\u2019s name, domain, or email', 'Your data being shared or used without permission', 'A date'],
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
  canReportRepayment, SUBJECT_TYPES, SUBJECT_SLUG, SLUG_FOR, CATEGORIES, REQUIREMENTS, categoriesFor,
  MAX_FILES, MAX_FILE_BYTES, ACCEPT_ATTR, fileType, safeName, sha256, fmtSize, parseWebsite,
};
