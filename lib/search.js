/**
 * Search: validation, matching reported parties (fx_subjects), and published results.
 *   individual:      first + last name, DOB, and email and/or mobile (+ optional home ZIP). A match needs DOB + last
 *                    name plus a matching email or mobile; the results show which details matched.
 *   vendor: company name and/or website (domain match wins).
 *   business:        EIN, legal name + state of registration, or both; reports found either way are returned, each
 *                    marked with what it matched on (name normalized; see lib/identity.js).
 *                    Business searches keep one-way keys so recent searches of the same business can be counted.
 * Only published reports are returned.
 */
const supabase = require('./supabase');
const { parseWebsite } = require('./reports');
const ID = require('./identity');
const { STATES } = require('./validate');

const PURPOSES = { underwriting: 'Underwriting', employment: 'Employment screening', partner_diligence: 'Vendor diligence' }; // key kept for existing search logs
const PURPOSES_FOR = { individual: ['employment'], company: ['partner_diligence'], merchant: ['underwriting'] };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const str = v => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const likeSafe = v => v.replace(/[%_\\,()]/g, ' ').trim();

function validateSearch(body, subjectType) {
  const errors = [];
  const q = {};
  // FCRA (permissible purpose) applies to individuals only. Vendor and business searches are about
  // companies: no purpose step; the log keeps the standard purpose for that search type.
  if (subjectType === 'individual') {
    const purpose = str(body.purpose);
    if (!PURPOSES_FOR[subjectType].includes(purpose)) errors.push('Choose the permissible purpose for this search.');
    else q.purpose = purpose;
  } else {
    q.purpose = PURPOSES_FOR[subjectType][0];
  }

  if (subjectType === 'individual') {
    // A match needs DOB + last name, plus email or mobile (lib/identity.js).
    const first = str(body.first_name).slice(0, 80);
    const last = str(body.last_name).slice(0, 80);
    if (!first || !last) errors.push('Enter the person’s first and last name.');
    else { q.first_name = first; q.last_name = last; q.name = `${first} ${last}`; }
    const dob = str(body.dob);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) errors.push('Enter the person’s date of birth.'); else q.dob = dob;
    const email = str(body.email).toLowerCase();
    if (email && !EMAIL_RE.test(email)) errors.push('Email is not a valid email address.'); else if (email) q.email = email;
    if (str(body.phone)) { q.phone = ID.normPhone(body.phone); if (!q.phone) errors.push('Mobile number must be a valid 10-digit US number.'); }
    const zip = str(body.zip);
    if (zip && !/^\d{5}$/.test(zip)) errors.push('Home ZIP code must be 5 digits.'); else if (zip) q.zip5 = zip;
    if (!email && !str(body.phone)) errors.push('Add an email or mobile number. Searches match on date of birth and last name plus one of these.');
  }
  if (subjectType === 'company') {
    const name = str(body.name).slice(0, 200);
    const raw = str(body.website);
    if (raw) { const site = parseWebsite(raw); if (!site) errors.push('Website is not a valid web address.'); else q.domain = site.domain; }
    if (name) q.name = name;
    if (!name && !raw) errors.push('Enter the company name or website.');
  }
  if (subjectType === 'merchant') {
    // Send what you have: the EIN, the legal name + state of registration, or all three. FinDex matches on each.
    const ein = str(body.ein).replace(/[\s-]/g, '');
    const name = str(body.name).slice(0, 200);
    const state = str(body.state).toUpperCase();
    if (ein) { if (!/^\d{9}$/.test(ein)) errors.push('EIN must be 9 digits (XX-XXXXXXX).'); else q.ein = ein; }
    if (name && STATES[state]) { q.name = name; q.state = state; }
    else if (ein) { if (name) q.name = name; }
    else if (name || state) {
      if (!name) errors.push('Enter the business legal name.');
      if (!STATES[state]) errors.push('Choose the state where the business is registered.');
    } else {
      errors.push('Enter the EIN, or the business legal name and state.');
    }
  }
  if (body.certify !== 'on') errors.push(subjectType === 'individual' ? 'Please certify the permissible purpose.' : 'Please confirm how you will use the results.');
  if (q.purpose === 'employment' && body.employment_certify !== 'on') errors.push('Please complete the employment screening certification.');
  return { errors, q };
}

// What we store about the search: never DOB, EIN, phone or ZIP values; only whether they were used.
function criteriaForLog(q) {
  return { name: q.name || null, email: q.email || null, domain: q.domain || null, state: q.state || null,
    dob: Boolean(q.dob), phone: Boolean(q.phone), zip: Boolean(q.zip5), ein: Boolean(q.ein) };
}

/**
 * Finds reported parties. Returns { ids, matched, keys }:
 *   matched: per subject, which details matched (no values), shown on the results so the searcher can confirm.
 *   keys:    one-way keys for a business search (EIN and/or name + state), stored with the search so FinDex can
 *            count recent searches of the same business.
 */
async function findSubjects(subjectType, q) {
  if (subjectType === 'merchant') {
    // EIN and/or legal name + state: reports found either way are returned, each marked with what it matched on.
    const keys = new Set();
    const rows = new Map();
    const by = {};
    const add = (list, how) => (list || []).forEach(r => { rows.set(r.id, r); (by[r.id] = by[r.id] || []).push(how); });
    if (q.ein) {
      keys.add(ID.einKey(q.ein));
      const { data, error } = await supabase.from('fx_subjects').select('id, identity_hash, biz_key').eq('subject_type', 'merchant').eq('identity_hash', ID.einKey(q.ein));
      if (error) throw new Error(`Search: ${error.message}`);
      add(data, 'ein');
    }
    if (q.name && q.state) {
      keys.add(ID.bizKey(q.state, q.name));
      const { data, error } = await supabase.from('fx_subjects').select('id, identity_hash, biz_key').eq('subject_type', 'merchant').eq('biz_key', ID.bizKey(q.state, q.name));
      if (error) throw new Error(`Search: ${error.message}`);
      add(data, 'name_state');
    }
    rows.forEach(r => { if (r.identity_hash) keys.add(r.identity_hash); if (r.biz_key) keys.add(r.biz_key); });
    const matched = Object.fromEntries([...rows.keys()].map(id => [id, { by: by[id] }]));
    return { ids: [...rows.keys()], matched, keys: [...keys] };
  }
  if (subjectType === 'company') {
    let query = supabase.from('fx_subjects').select('id').eq('subject_type', 'company');
    query = q.domain ? query.eq('domain', q.domain) : query.ilike('name_search', `%${likeSafe(q.name.toLowerCase())}%`).limit(25);
    const { data, error } = await query;
    if (error) throw new Error(`Search: ${error.message}`);
    return { ids: (data || []).map(r => r.id), matched: {}, keys: [] };
  }
  // individual: DOB + last name narrow it down; email or mobile must also match.
  const { data: cands, error } = await supabase.from('fx_subjects').select('id, name, zip5')
    .eq('subject_type', 'individual').eq('identity_hash', ID.personKey(q.dob, q.last_name));
  if (error) throw new Error(`Search: ${error.message}`);
  const ids = (cands || []).map(c => c.id);
  if (!ids.length) return { ids: [], matched: {}, keys: [] };
  const [{ data: em }, { data: ph }] = await Promise.all([
    q.email ? supabase.from('fx_subject_emails').select('subject_id').in('subject_id', ids).eq('email', q.email) : Promise.resolve({ data: [] }),
    q.phone ? supabase.from('fx_subject_phones').select('subject_id').in('subject_id', ids).eq('phone', q.phone) : Promise.resolve({ data: [] }),
  ]);
  const byEmail = new Set((em || []).map(r => r.subject_id));
  const byPhone = new Set((ph || []).map(r => r.subject_id));
  const matched = {};
  for (const c of cands) {
    if (!byEmail.has(c.id) && !byPhone.has(c.id)) continue;
    matched[c.id] = {
      dob: true, last_name: true, email: byEmail.has(c.id), phone: byPhone.has(c.id),
      zip: q.zip5 && c.zip5 ? (q.zip5 === c.zip5 ? 'match' : 'differs') : null,
      first_name: nameLooksSame(q.first_name, c.name),
    };
  }
  return { ids: Object.keys(matched), matched, keys: [] };
}

/** Searches of the same business by other companies in the last `days` days: { searches, companies }. */
async function recentActivity(keys, accountId, days = 30) {
  if (!keys || !keys.length) return { searches: 0, companies: 0 };
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase.from('fx_searches').select('account_id')
    .eq('subject_type', 'merchant').overlaps('subject_keys', keys).gte('created_at', since).neq('account_id', accountId);
  if (error) throw new Error(`Search activity: ${error.message}`);
  return { searches: (data || []).length, companies: new Set((data || []).map(r => r.account_id)).size };
}

// True when the searched name plausibly matches the name on file (shared last or first name part).
function nameLooksSame(searched, onFile) {
  const a = String(searched || '').toLowerCase().split(/[^a-z]+/).filter(t => t.length >= 2);
  const b = new Set(String(onFile || '').toLowerCase().split(/[^a-z]+/).filter(t => t.length >= 2));
  return a.some(t => b.has(t));
}

async function publishedReportsFor(subjectIds) {
  if (!subjectIds.length) return [];
  const { data, error } = await supabase.from('fx_reports')
    .select('id, subject_id, category, incident_date, description, published_at, subject_name_reported, reporter:fx_accounts!fx_reports_reporter_account_id_fkey(business_legal_name, company_type)')
    .in('subject_id', subjectIds).eq('status', 'published').order('incident_date', { ascending: false }).limit(200);
  if (error) throw new Error(`Search results: ${error.message}`);
  return data || [];
}

module.exports = { nameLooksSame, PURPOSES, PURPOSES_FOR, validateSearch, criteriaForLog, findSubjects, recentActivity, publishedReportsFor };
