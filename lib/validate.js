/**
 * Server-side validation and normalization for the Request Access form.
 * validateRequest(body) -> { errors: string[], data: {...} }
 * `data` holds normalized plaintext; sensitive fields are encrypted by the caller.
 */
const { MEMBER_TERMS_VERSION } = require('./terms');

const ACCOUNT_TYPES = {
  company: 'Company',
  individual: 'Individual',
  merchant: 'Funded Business',
};

const COMPANY_TYPES = {
  broker: 'Broker',
  funder: 'Funder',
  lender: 'Lender',
  software_provider: 'Software Provider',
  lead_provider: 'Lead Provider',
};

const WORKER_TYPES = { employee: 'Employee', contractor: 'Contractor' };

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// Free / consumer mailbox providers. Company accounts must use a domain they control.
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'passport.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aim.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.us', 'mail.com', 'email.com',
  'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru', 'tutanota.com', 'tuta.io', 'fastmail.com',
  'hushmail.com', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'comcast.net', 'verizon.net',
  'cox.net', 'charter.net', 'earthlink.net', 'optonline.net', 'frontier.com', 'juno.com', 'netzero.net',
  'mail.ru', 'qq.com', '163.com', 'inbox.com', 'hey.com', 'duck.com', 'skiff.com', 'yahoo.co.uk',
  'hotmail.co.uk', 'outlook.co.uk', 'live.co.uk', 'btinternet.com', 'rediffmail.com',
]);

const str = v => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const isTestName = v => /^\[test\]/i.test(v || '');

function text(errors, value, label, { required = true, max = 120 } = {}) {
  const v = str(value);
  if (!v) { if (required) errors.push(`${label} is required.`); return null; }
  if (v.length > max) { errors.push(`${label} must be ${max} characters or fewer.`); return null; }
  return v;
}

function email(errors, value, label = 'Email') {
  const v = str(value).toLowerCase();
  if (!v) { errors.push(`${label} is required.`); return null; }
  if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v)) { errors.push(`${label} is not a valid email address.`); return null; }
  return v;
}

function phone(errors, value) {
  const raw = str(value);
  if (!raw) { errors.push('Phone is required.'); return null; }
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 10) digits = `1${digits}`;
  if (raw.startsWith('+') ? digits.length < 8 || digits.length > 15 : !(digits.length === 11 && digits[0] === '1')) {
    errors.push('Phone must be a valid 10-digit US number (or start with + and a country code).');
    return null;
  }
  return `+${digits}`;
}

// Returns { origin, domain } or null. domain drops a leading "www.".
function parseWebsite(value) {
  let v = str(value);
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  let url;
  try { url = new URL(v); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || url.username || url.password) return null;
  return { origin: `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`, domain: host.replace(/^www\./, '') };
}

// Email domain must be the website's domain, or one a subdomain of the other.
function domainsMatch(emailDomain, siteDomain) {
  return emailDomain === siteDomain
    || emailDomain.endsWith(`.${siteDomain}`)
    || siteDomain.endsWith(`.${emailDomain}`);
}

function state(errors, value, label) {
  const v = str(value).toUpperCase();
  if (!STATES[v]) { errors.push(`${label} is required.`); return null; }
  return v;
}

function choice(errors, value, options, label, { required = true } = {}) {
  const v = str(value);
  if (!v) { if (required) errors.push(`${label} is required.`); return null; }
  if (!Object.prototype.hasOwnProperty.call(options, v)) { errors.push(`${label} is not a valid choice.`); return null; }
  return v;
}

function dob(errors, value, label = 'Date of birth') {
  const v = str(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) { errors.push(`${label} is required.`); return null; }
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    errors.push(`${label} is not a valid date.`); return null;
  }
  const now = new Date();
  const age = (now - d) / (365.25 * 24 * 3600 * 1000);
  if (age < 18 || age > 110) { errors.push(`${label} must show you are at least 18.`); return null; }
  return v;
}

function ssnLast4(errors, value, label = 'Last 4 of SSN') {
  const v = str(value);
  if (!/^\d{4}$/.test(v) || v === '0000') { errors.push(`${label} must be 4 digits.`); return null; }
  return v;
}

function ein(errors, value) {
  const digits = str(value).replace(/[\s-]/g, '');
  if (!/^\d{9}$/.test(digits) || digits.startsWith('00') || digits === '000000000') {
    errors.push('EIN must be 9 digits (XX-XXXXXXX).'); return null;
  }
  return digits;
}

function checked(errors, value, message) {
  if (value !== 'on' && value !== 'yes' && value !== true) { errors.push(message); return false; }
  return true;
}

function validateRequest(body) {
  const errors = [];
  const type = choice(errors, body.account_type, ACCOUNT_TYPES, 'Account type');
  if (!type) return { errors: ['Please choose company, individual, or funded business.'], data: null };

  const d = {
    account_type: type,
    first_name: text(errors, body.first_name, 'First name', { max: 80 }),
    last_name: text(errors, body.last_name, 'Last name', { max: 80 }),
    email: email(errors, body.email, type === 'company' ? 'Business email' : 'Email'),
    phone: phone(errors, body.phone),
  };

  if (type === 'company') {
    d.business_legal_name = text(errors, body.business_legal_name, 'Company legal name', { max: 200 });
    d.business_dba = text(errors, body.business_dba, 'DBA', { required: false, max: 200 });
    d.company_type = choice(errors, body.company_type, COMPANY_TYPES, 'Company type');
    d.state_of_registration = state(errors, body.state_of_registration, 'State of registration');
    d.job_title = text(errors, body.job_title, 'Job title', { max: 120 });
    const site = parseWebsite(body.website);
    if (!str(body.website)) errors.push('Company website is required.');
    else if (!site) errors.push('Company website is not a valid web address.');
    if (site) d.website = site.origin;
    if (d.email) {
      const emailDomain = d.email.split('@')[1];
      if (FREE_EMAIL_DOMAINS.has(emailDomain)) {
        errors.push('Please use your company email address. Free email providers (Gmail, Yahoo, Outlook, etc.) are not accepted for company accounts.');
      } else if (site && !domainsMatch(emailDomain, site.domain)) {
        errors.push(`Your business email must be on your company website's domain (${site.domain}).`);
      } else if (site) {
        d.email_domain = site.domain;
      }
    }
    checked(errors, body.authorize, 'Please confirm you are authorized to request access for this company.');
    if (checked(errors, body.member_terms, 'Please accept the FinDex Member Terms.')) d.terms_version = MEMBER_TERMS_VERSION;
  }

  if (type === 'individual') {
    d.current_company = text(errors, body.current_company, 'Current or most recent company', { required: false, max: 200 });
    d.worker_type = choice(errors, body.worker_type, WORKER_TYPES, 'Employee or contractor', { required: false });
    d.job_title = text(errors, body.job_title, 'Job title', { required: false, max: 120 });
    d.identity_method = 'dob_ssn4';
    d.dob = dob(errors, body.dob);
    d.ssn_last4 = ssnLast4(errors, body.ssn_last4);
  }

  if (type === 'merchant') {
    d.business_legal_name = text(errors, body.business_legal_name, 'Business legal name', { max: 200 });
    d.business_dba = text(errors, body.business_dba, 'DBA', { required: false, max: 200 });
    d.state_of_registration = state(errors, body.state_of_registration, 'State of registration');
    d.job_title = text(errors, body.job_title, 'Your title', { max: 120 });
    if (str(body.website)) {
      const site = parseWebsite(body.website);
      if (!site) errors.push('Business website is not a valid web address.');
      else d.website = site.origin;
    }
    d.identity_method = body.identity_method === 'dob_ssn4' ? 'dob_ssn4' : 'ein';
    if (d.identity_method === 'ein') {
      d.ein = ein(errors, body.ein);
    } else {
      d.dob = dob(errors, body.dob, "Owner's date of birth");
      d.ssn_last4 = ssnLast4(errors, body.ssn_last4, "Owner's last 4 of SSN");
    }
  }

  checked(errors, body.attest, 'Please confirm the information you provided is accurate.');

  d.is_test = [d.first_name, d.last_name, d.business_legal_name].some(isTestName);
  return { errors, data: errors.length ? null : d };
}

module.exports = {
  validateRequest, parseWebsite, domainsMatch,
  ACCOUNT_TYPES, COMPANY_TYPES, WORKER_TYPES, STATES, FREE_EMAIL_DOMAINS,
};
