/**
 * Report rules shared by the member form, admin, and (later) the API.
 *   - which categories apply to which subject type, and which need a funder
 *   - subject validation and normalization (identifiers encrypted by the caller)
 *   - evidence file limits
 */
const crypto = require('crypto');
const { parseWebsite } = require('./validate');

// Internal code 'company' = a vendor (URL /vendor; old /partner links redirect).
// 'merchant' = a business that applied for or received funding (URL /merchant; old /funded-business links redirect).
const SUBJECT_TYPES = { individual: 'Individual', company: 'Vendor', merchant: 'Merchant' };
const SUBJECT_SLUG = { individual: 'individual', vendor: 'company', merchant: 'merchant' };
const SLUG_FOR = { individual: 'individual', company: 'vendor', merchant: 'merchant' };

// Vendor type, picked on the vendor report form (fx_subjects.vendor_type).
const VENDOR_TYPES = {
  crm_los: 'CRM or LOS',
  underwriting: 'Underwriting & Decisioning',
  document_fraud: 'Document Processing & Fraud Detection',
  lead_data: 'Lead & Data Providers',
  marketplace: 'Marketplaces & Submission Platforms',
  payments_servicing: 'Payments, Servicing & Collections',
  outsourced_ops: 'Outsourced Operations',
  it_security: 'IT & Security',
  legal_compliance: 'Legal & Compliance',
  broker_partner: 'Broker partner',
  lender_partner: 'Lender partner',
  other: 'Other Service Providers',
};

// Keys are the stored values (fx_reports.category); labels are what people see. Order = the pick-list order.
// Keys kept from earlier names so no database change was needed: data_theft = Theft, merchant_deception = False
// Statements, fraud = Document Tampering, impersonation = Unauthorized Activity.
const CATEGORIES = {
  data_mishandling:   { label: 'Data Mishandling', subjects: ['individual', 'company'] },
  data_theft:         { label: 'Theft', subjects: ['individual', 'company'] },
  merchant_deception: { label: 'False Statements', subjects: ['individual', 'company'] },
  fraud:              { label: 'Document Tampering', subjects: ['individual', 'company', 'merchant'] },
  impersonation:      { label: 'Unauthorized Activity', subjects: ['individual', 'company'] },
  default:            { label: 'Default', subjects: ['merchant'], fundersOnly: true, needsDefaultNotice: true },
  // Retired: kept only so older reports still show a category name. No subjects, so it can't be chosen.
  missed_payments:    { label: 'Payment delinquency', subjects: [], fundersOnly: true },
};

// Repayment reports (defaults) capture only the date.
const REPAYMENT_FIELDS = {
  default: { dateLabel: 'Default date', maxAgeDays: 90 }, // defaults must be reported within 90 days
};

// Each requirement is either plain text or [label, text] (shown as "label: text").
const reqLabel = (r) => (Array.isArray(r) ? r[0] : r);
const reqText = (r) => (Array.isArray(r) ? `${r[0]}: ${r[1]}` : r);

// "What we need to see": one list per category (who, what, when), shown on the report form AND used as the AI
// review checklist. GUIDANCE adds category-specific notes shown under the list and given to the AI.
const REQUIREMENTS = {
  default: [
    ['Default notice', 'A copy of the formal default notice identifying the merchant and the date of default.'],
    ['Proof of delivery', 'Evidence that the notice was sent to the merchant, such as a sent email, delivery confirmation, or system-generated notification log.'],
  ],
  data_mishandling: [
    ['The reported party\u2019s identity', 'Name, email address, phone number, or other identifying information.'],
    ['Data mishandling', 'Evidence showing your data was accessed, shared, exposed, or used without authorization.'],
    ['Date', 'When the incident occurred or was discovered.'],
  ],
  data_theft: [
    ['The reported party\u2019s identity', 'Name, email address, phone number, or other identifying information.'],
    ['Theft', 'Evidence showing company data, business, or funds were taken or diverted without permission.'],
    ['Date', 'When the incident occurred or was discovered.'],
  ],
  merchant_deception: [
    ['The reported party\u2019s identity', 'Name, email address, phone number, or other identifying information.'],
    ['False statement', 'The statement or communication, and who received it.'],
    ['Date', 'When the incident occurred or was discovered.'],
  ],
  fraud: [
    ['The reported party\u2019s identity', 'Name, email address, phone number, or other identifying information.'],
    ['Document tampering', 'Evidence showing what was altered or falsified.'],
    ['Connection to the reported party', 'Evidence linking the reported party to the tampering or submission of the altered document.'],
  ],
  impersonation: [
    ['The reported party\u2019s identity', 'Name, email address, phone number, or other identifying information.'],
    ['Unauthorized activity', 'Evidence showing what was done without permission, and that the reported party did it.'],
    ['Date', 'When the incident occurred or was discovered.'],
  ],
};

// Evidence we accept, per category (shown under the list and given to the AI review).
const PHONE_NOTE = 'For phone calls, provide the call log and recording or transcript exported directly from your phone system (not a manually typed document), along with evidence linking the phone numbers to the parties involved. Calls must have been lawfully recorded.';
const GUIDANCE = {
  default: 'The default date is the date your company formally declared the merchant in default, not the date of the first missed payment. If the merchant has since settled the balance, say so in the description.',
  data_mishandling: 'Accepted evidence: emails, messages, breach notifications, access logs, or recorded phone calls. Do not upload the sensitive data itself.\n\n' + PHONE_NOTE,
  data_theft: 'Accepted evidence: emails or attachments sent to outside addresses, file transfer or export logs, CRM or system records, or funding and commission records. Do not upload the sensitive data itself.',
  merchant_deception: 'Accepted evidence: emails, text or chat messages, or recorded phone calls.\n\n' + PHONE_NOTE,
  fraud: 'Accepted evidence: the original and altered versions of the document, results from your fraud detection provider, or email correspondence.',
  impersonation: 'Accepted evidence: emails, messages, system or login records, application records, or recorded phone calls. Do not upload Social Security or other government ID numbers.\n\n' + PHONE_NOTE,
};

// Repayment categories (default) are for funders and lenders.
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

const COMPANY_REQUIREMENTS = {};
const COMPANY_GUIDANCE = {};
// The first checklist item names the reported party the same way on each form.
const PARTY_LABEL = { individual: 'Reported individual', company: 'Reported company', merchant: 'Reported merchant' };
const PARTY_TEXT = { company: 'Business name, domain, email address, or phone number.', merchant: 'Business name, EIN, email address, or phone number.' };
const GENERIC_PARTY = ['The reported party\u2019s identity', 'Merchant identity'];
const requirementsFor = (category, subjectType) => {
  const list = (subjectType === 'company' && COMPANY_REQUIREMENTS[category]) || REQUIREMENTS[category] || [];
  return list.map(item => {
    if (!Array.isArray(item) || !GENERIC_PARTY.includes(item[0]) || !PARTY_LABEL[subjectType]) return item;
    // Generic identity wording gets the form's own; Missed payments keeps "Business name or EIN".
    const text = item[0] === 'Merchant identity' ? item[1] : (PARTY_TEXT[subjectType] || item[1]);
    return [PARTY_LABEL[subjectType], text];
  });
};
const guidanceFor = (category, subjectType) => (subjectType === 'company' && COMPANY_GUIDANCE[category]) || GUIDANCE[category] || '';

module.exports = {
  canReportRepayment, VENDOR_TYPES, SUBJECT_TYPES, SUBJECT_SLUG, SLUG_FOR, CATEGORIES, REQUIREMENTS, requirementsFor, guidanceFor, reqLabel, reqText, GUIDANCE, REPAYMENT_FIELDS, categoriesFor,
  MAX_FILES, MAX_FILE_BYTES, ACCEPT_ATTR, fileType, safeName, sha256, fmtSize, parseWebsite,
};
