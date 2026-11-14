/**
 * Validates a report submission. validateReport(body, files, { subjectType, account })
 * -> { errors, subject, report, uploads }. Sensitive identifiers come back in plaintext; the caller encrypts.
 */
const { CATEGORIES, REPAYMENT_FIELDS: R_FIELDS, categoriesFor, MAX_FILES, MAX_FILE_BYTES, fileType, parseWebsite } = require('./reports');

const str = v => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function text(errors, value, label, { required = true, max = 200 } = {}) {
  const v = str(value);
  if (!v) { if (required) errors.push(`${label} is required.`); return null; }
  if (v.length > max) { errors.push(`${label} must be ${max} characters or fewer.`); return null; }
  return v;
}

function email(errors, value, label) {
  const v = str(value).toLowerCase();
  if (!v) { errors.push(`${label} is required.`); return null; }
  if (v.length > 254 || !EMAIL_RE.test(v)) { errors.push(`${label} is not a valid email address.`); return null; }
  return v;
}

function isoDate(errors, value, label) {
  const v = str(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) { errors.push(`${label} is required.`); return null; }
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) { errors.push(`${label} is not a valid date.`); return null; }
  return { v, d };
}

function validateReport(body, files, { subjectType, account }) {
  const errors = [];
  const subject = { subject_type: subjectType };
  const report = {};

  // --- who is being reported ---
  if (subjectType === 'individual') {
    subject.name = text(errors, body.subject_name, 'Full name', { max: 160 });
    const dob = isoDate(errors, body.subject_dob, 'Date of birth');
    if (dob) {
      const age = (Date.now() - dob.d) / (365.25 * 24 * 3600 * 1000);
      if (age < 16 || age > 110) errors.push('Date of birth doesn’t look right.');
      else subject.dob = dob.v;
    }
    const ssn = str(body.subject_ssn_last4);
    if (!/^\d{4}$/.test(ssn) || ssn === '0000') errors.push('Last 4 of SSN must be 4 digits.');
    else subject.ssn_last4 = ssn;
  }
  if (subjectType === 'company') {
    subject.name = text(errors, body.subject_name, 'Company name', { max: 200 });
    const raw = str(body.subject_website);
    const site = parseWebsite(raw);
    if (!raw) errors.push('Company website is required.');
    else if (!site) errors.push('Company website is not a valid web address.');
    else { subject.website = site.origin; subject.domain = site.domain; }
    subject.contact_name = text(errors, body.subject_contact, 'Contact person', { max: 160 });
  }
  if (subjectType === 'merchant') {
    subject.name = text(errors, body.subject_name, 'Business legal name', { max: 200 });
    subject.dba = text(errors, body.subject_dba, 'DBA', { required: false, max: 200 });
    const ein = str(body.subject_ein).replace(/[\s-]/g, '');
    if (!/^\d{9}$/.test(ein) || ein.startsWith('00')) errors.push('EIN must be 9 digits (XX-XXXXXXX).');
    else subject.ein = ein;
    subject.contact_name = text(errors, body.subject_contact, 'Contact person', { max: 160 });
  }
  report.notice_email = email(errors, body.subject_email, subjectType === 'individual' ? 'Email' : 'Contact email');

  // --- what happened ---
  const allowed = categoriesFor(subjectType, account).map(c => c.key);
  const category = str(body.category);
  if (!category) errors.push('Category is required.');
  else if (!allowed.includes(category)) errors.push('That category isn’t available for this report.');
  else report.category = category;

  const dateLabel = (category && R_FIELDS[category] && R_FIELDS[category].dateLabel) || 'Incident date';
  const inc = isoDate(errors, body.incident_date, dateLabel);
  if (inc) {
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const sevenYearsAgo = new Date(today); sevenYearsAgo.setUTCFullYear(today.getUTCFullYear() - 7);
    if (inc.d > today) errors.push(`${dateLabel} can\u2019t be in the future.`);
    else if (inc.d < sevenYearsAgo) errors.push('Incidents must be within the past 7 years.');
    else report.incident_date = inc.v;
  }


  const desc = typeof body.description === 'string' ? body.description.trim() : '';
  if (!desc) { if (!(category && R_FIELDS[category])) errors.push('Description is required.'); else report.description = null; }
  else if (desc.length > 5000) errors.push('Description must be 5,000 characters or fewer.');
  else report.description = desc;

  // --- evidence ---
  const evidence = (files && files.evidence) || [];
  const defaultNotice = (files && files.default_notice) || [];
  const uploads = [];
  const all = [...evidence.map(f => ['evidence', f]), ...defaultNotice.map(f => ['default_notice', f])];
  if (!evidence.length) errors.push('Add at least one evidence file.');
  if (report.category && CATEGORIES[report.category].needsDefaultNotice && !defaultNotice.length) {
    errors.push('Default reports must include a copy of the default notice sent to the merchant.');
  }
  if (all.length > MAX_FILES) errors.push(`Up to ${MAX_FILES} files per report.`);
  for (const [kind, f] of all) {
    const type = fileType(f);
    if (!type) { errors.push(`“${f.originalname}” isn’t an accepted file type.`); continue; }
    if (f.size > MAX_FILE_BYTES) { errors.push(`“${f.originalname}” is larger than 25 MB.`); continue; }
    if (!f.size) { errors.push(`“${f.originalname}” is empty.`); continue; }
    uploads.push({ kind, file: f, mime: type });
  }

  if (body.certify !== 'on') {
    errors.push('Please confirm the report is accurate and the evidence is redacted.');
  }
  report.subject_name_reported = subject.name;

  return { errors, subject, report, uploads };
}

module.exports = { validateReport };
