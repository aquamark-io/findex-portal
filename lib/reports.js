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
  slow_pay:           { label: 'Slow pay', subjects: ['merchant'], fundersOnly: true },
  missed_payments:    { label: 'Missed payments', subjects: ['merchant'], fundersOnly: true },
  default:            { label: 'Default', subjects: ['merchant'], fundersOnly: true, needsDefaultNotice: true },
};

// Evidence guidance shown in the form (matches the joinfindex.com FAQ).
const EVIDENCE_HINTS = {
  data_theft: 'Emails or messages redirecting merchants or deals, CRM records, system activity, and access logs.',
  merchant_deception: 'Communications with misleading or false representations, plus documents establishing the actual facts.',
  fraud: 'Copies of the documents or files suspected of manipulation, plus evidence linking the activity to the reported party. Fraud detection reports may be added as support.',
  data_mishandling: 'Communications, access logs, or system records showing unauthorized sharing, disclosure, or use of data.',
  slow_pay: 'Payment history from your system of record showing late payments.',
  missed_payments: 'Payment history from your system of record showing missed or returned payments.',
  default: 'Payment history from your system of record, plus a copy of the default notice sent to the merchant.',
};

// Repayment categories (slow pay, missed payments, default) are for funders and lenders.
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
  canReportRepayment, SUBJECT_TYPES, SUBJECT_SLUG, SLUG_FOR, CATEGORIES, EVIDENCE_HINTS, categoriesFor,
  MAX_FILES, MAX_FILE_BYTES, ACCEPT_ATTR, fileType, safeName, sha256, fmtSize, parseWebsite,
};
