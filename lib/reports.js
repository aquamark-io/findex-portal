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

// Keys are the stored values (fx_reports.category); labels are what people see. Order = the pick-list order
// (alphabetical). Some keys predate their labels: fraud = Document Tampering, merchant_deception = False or
// Misleading Statements, default = Defaulted on Financing.
const IV = ['individual', 'company'];
const CATEGORIES = {
  accidental_data_exposure: { label: 'Accidental Data Exposure', subjects: IV },
  data_theft:               { label: 'Data Theft (Backdooring)', subjects: IV },
  default:                  { label: 'Defaulted on Financing', subjects: ['merchant'], fundersOnly: true, needsDefaultNotice: true },
  fraud:                    { label: 'Document Tampering', subjects: ['individual', 'company', 'merchant'] },
  merchant_deception:       { label: 'False or Misleading Statements', subjects: IV },
  impersonation:            { label: 'Impersonation', subjects: IV },
  no_state_license:         { label: 'Operating without State License', subjects: IV },
  no_state_registration:    { label: 'Operating without State Registration', subjects: IV },
  unauthorized_fees:        { label: 'Unauthorized Fees', subjects: IV },
  regulatory_violation:     { label: 'Violation of FCRA, ECOA, UDAP, or TCPA', subjects: IV },
  // Retired: kept only so older reports still show a category name. No subjects, so they can't be chosen.
  data_mishandling:         { label: 'Data Mishandling', subjects: [] },
  missed_payments:          { label: 'Payment delinquency', subjects: [], fundersOnly: true },
};

// Repayment reports (defaults) capture only the date.
const REPAYMENT_FIELDS = {
  default: { dateLabel: 'Default date', maxAgeDays: 90 }, // defaults must be reported within 90 days
};

// Each requirement is either plain text or [label, text] (shown as "label: text").
const reqLabel = (r) => (Array.isArray(r) ? r[0] : r);
const reqText = (r) => (Array.isArray(r) ? `${r[0]}: ${r[1]}` : r);


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

// AI evidence review checklist: one general list for every category; defaults have their own two items.
// ACCEPTED_EVIDENCE mirrors the website FAQ ("What evidence does FinDex accept?").
const ACCEPTED_EVIDENCE = [
  'Emails', 'Text messages', 'Online chat transcripts', 'Call recordings', 'Screenshots', 'Screen recordings',
  'System access and activity logs', 'Applications, bank statements, and other supporting documents', 'Fraud detection reports',
  'Invoices, payment requests, and receipts', 'Funding and commission records', 'Default notices and related correspondence',
  'Data breach or incident notifications', 'Written policies', 'Fee schedules',
];
const GENERAL_REQUIREMENTS = [
  ['The reported party\u2019s identity', 'Name, email address, phone number, or other identifying information.'],
  ['The incident', 'Evidence of what the description says happened, consistent with the chosen category.'],
  ['Connection to the reported party', 'Evidence linking the reported party to the incident.'],
  ['Date', 'When the incident occurred or was discovered.'],
];
const REQUIREMENTS = {
  default: [
    ['Default notice', 'A copy of the formal default notice identifying the merchant and the date of default.'],
    ['Proof of delivery', 'Evidence that the notice was sent to the merchant, such as a sent email, delivery confirmation, or system-generated notification log.'],
  ],
};
const GENERAL_GUIDANCE = `Accepted evidence includes, but is not limited to: ${ACCEPTED_EVIDENCE.join('; ')}. Personally identifiable information that isn\u2019t needed to verify the incident should be redacted.`;
const DEFAULT_NOTE = 'The default date is the date the company formally declared the merchant in default, not the date of the first missed payment. If the merchant has since settled the balance, the description should say so.';
// The first checklist item names the reported party the way the report form does.
const PARTY_LABEL = { individual: 'Reported individual', company: 'Reported company', merchant: 'Reported merchant' };
const PARTY_TEXT = { company: 'Business name, domain, email address, or phone number.', merchant: 'Business name, EIN, email address, or phone number.' };
const requirementsFor = (category, subjectType) => {
  if (REQUIREMENTS[category]) return REQUIREMENTS[category];
  const [first, ...rest] = GENERAL_REQUIREMENTS;
  return [PARTY_LABEL[subjectType] ? [PARTY_LABEL[subjectType], PARTY_TEXT[subjectType] || first[1]] : first, ...rest];
};
const guidanceFor = category => (category === 'default' ? `${DEFAULT_NOTE}\n\n${GENERAL_GUIDANCE}` : GENERAL_GUIDANCE);

module.exports = {
  canReportRepayment, VENDOR_TYPES, SUBJECT_TYPES, SUBJECT_SLUG, SLUG_FOR, CATEGORIES, REQUIREMENTS, requirementsFor, guidanceFor, reqLabel, reqText, ACCEPTED_EVIDENCE, REPAYMENT_FIELDS, categoriesFor,
  MAX_FILES, MAX_FILE_BYTES, ACCEPT_ATTR, fileType, safeName, sha256, fmtSize, parseWebsite,
};
