/**
 * Search: validation, matching reported parties (fx_subjects), and published results.
 *   individual:      full name + email and/or DOB (+ SSN last 4). Identifiers decide the match; the name is shown
 *                    back so the searcher can confirm it's the same person (spelling differences don't block a match).
 *   partner company: company name and/or website (domain match wins).
 *   funded business: legal name + EIN; the EIN decides the match.
 * Only published reports are returned.
 */
const supabase = require('./supabase');
const { blindIndex, decrypt } = require('./crypto');
const { parseWebsite } = require('./reports');

const PURPOSES = { underwriting: 'Underwriting', employment: 'Employment screening', partner_diligence: 'Partner diligence' };
const PURPOSES_FOR = { individual: ['employment', 'partner_diligence', 'underwriting'], company: ['partner_diligence'], merchant: ['underwriting'] };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const str = v => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const likeSafe = v => v.replace(/[%_\\,()]/g, ' ').trim();

function validateSearch(body, subjectType) {
  const errors = [];
  const q = {};
  const purpose = str(body.purpose);
  if (!PURPOSES_FOR[subjectType].includes(purpose)) errors.push('Choose the permissible purpose for this search.');
  else q.purpose = purpose;

  if (subjectType === 'individual') {
    const name = str(body.name);
    if (name.split(' ').filter(Boolean).length < 2) errors.push('Enter the person’s full name (first and last).');
    else q.name = name.slice(0, 160);
    const email = str(body.email).toLowerCase();
    if (email && !EMAIL_RE.test(email)) errors.push('Email is not a valid email address.'); else if (email) q.email = email;
    const dob = str(body.dob);
    if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) errors.push('Date of birth is not a valid date.'); else if (dob) q.dob = dob;
    const ssn = str(body.ssn_last4);
    if (ssn && !/^\d{4}$/.test(ssn)) errors.push('Last 4 of SSN must be 4 digits.');
    else if (ssn && !q.dob) errors.push('Last 4 of SSN must be used together with date of birth.');
    else if (ssn) q.ssn_last4 = ssn;
    if (!email && !dob) errors.push('Add a second identifier: email or date of birth (searches never use name alone).');
  }
  if (subjectType === 'company') {
    const name = str(body.name).slice(0, 200);
    const raw = str(body.website);
    if (raw) { const site = parseWebsite(raw); if (!site) errors.push('Website is not a valid web address.'); else q.domain = site.domain; }
    if (name) q.name = name;
    if (!name && !raw) errors.push('Enter the company name or website.');
  }
  if (subjectType === 'merchant') {
    const name = str(body.name);
    if (!name) errors.push('Business legal name is required.'); else q.name = name.slice(0, 200);
    const ein = str(body.ein).replace(/[\s-]/g, '');
    if (!/^\d{9}$/.test(ein)) errors.push('EIN must be 9 digits (XX-XXXXXXX).'); else q.ein = ein;
  }
  if (body.certify !== 'on') errors.push('Please certify the permissible purpose.');
  if (q.purpose === 'employment' && body.employment_certify !== 'on') errors.push('Please complete the employment screening certification.');
  return { errors, q };
}

// What we store about the search: never DOB, SSN or EIN values.
function criteriaForLog(q) {
  return { name: q.name || null, email: q.email || null, domain: q.domain || null, dob: Boolean(q.dob), ssn_last4: Boolean(q.ssn_last4), ein: Boolean(q.ein) };
}

async function findSubjects(subjectType, q) {
  if (subjectType === 'merchant') {
    const { data, error } = await supabase.from('fx_subjects').select('id').eq('subject_type', 'merchant').eq('identity_hash', blindIndex(`ein:${q.ein}`));
    if (error) throw new Error(`Search: ${error.message}`);
    return (data || []).map(r => r.id);
  }
  if (subjectType === 'company') {
    if (q.domain) {
      const { data, error } = await supabase.from('fx_subjects').select('id').eq('subject_type', 'company').eq('domain', q.domain);
      if (error) throw new Error(`Search: ${error.message}`);
      return (data || []).map(r => r.id);
    }
    const { data, error } = await supabase.from('fx_subjects').select('id').eq('subject_type', 'company').ilike('name_search', `%${likeSafe(q.name.toLowerCase())}%`).limit(25);
    if (error) throw new Error(`Search: ${error.message}`);
    return (data || []).map(r => r.id);
  }
  // individual: identifiers decide the match, not name spelling.
  //   DOB + SSN last 4 -> exact identity match (name ignored)
  //   email            -> exact email match (+ DOB if also given)
  //   DOB only         -> loose name match (any name part) + exact DOB
  const sel = 'id, name, dob_enc, identity_hash';
  let candidates = [];
  if (q.dob && q.ssn_last4) {
    const { data, error } = await supabase.from('fx_subjects').select(sel).eq('subject_type', 'individual').eq('identity_hash', blindIndex(`person:${q.dob}:${q.ssn_last4}`));
    if (error) throw new Error(`Search: ${error.message}`);
    candidates = data || [];
  } else if (q.email) {
    const { data: em } = await supabase.from('fx_subject_emails').select('subject_id').eq('email', q.email);
    const ids = [...new Set((em || []).map(r => r.subject_id))];
    if (ids.length) {
      const { data } = await supabase.from('fx_subjects').select(sel).eq('subject_type', 'individual').in('id', ids);
      candidates = data || [];
    }
  } else if (q.dob) {
    const parts = q.name.toLowerCase().split(' ').filter(t => t.length >= 2).slice(0, 4);
    const ors = parts.map(t => `name_search.ilike.%${likeSafe(t)}%`).join(',');
    if (ors) {
      const { data, error } = await supabase.from('fx_subjects').select(sel).eq('subject_type', 'individual').or(ors).limit(500);
      if (error) throw new Error(`Search: ${error.message}`);
      candidates = data || [];
    }
  }
  return candidates.filter(c => {
    if (q.dob && !(q.dob && q.ssn_last4)) { try { return decrypt(c.dob_enc) === q.dob; } catch { return false; } }
    return true;
  }).map(c => c.id);
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
    .select('id, subject_id, category, incident_date, description, published_at, missed_count, payment_frequency, delinquency_status, caught_up_on, subject_name_reported, reporter:fx_accounts!fx_reports_reporter_account_id_fkey(business_legal_name, company_type)')
    .in('subject_id', subjectIds).eq('status', 'published').order('incident_date', { ascending: false }).limit(200);
  if (error) throw new Error(`Search results: ${error.message}`);
  return data || [];
}

module.exports = { nameLooksSame, PURPOSES, PURPOSES_FOR, validateSearch, criteriaForLog, findSubjects, publishedReportsFor };
