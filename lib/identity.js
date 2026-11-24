/**
 * Matching rules, shared by reporting, search and account linking.
 *
 * People (no SSN): a match needs the same date of birth AND last name, plus a matching email OR mobile number.
 *   personKey(dob, last) is an HMAC of DOB + normalized last name. Many people can share one, so it narrows the
 *   candidates and the email / mobile check decides.
 * Businesses: the EIN decides (einKey). Without an EIN, legal name + state of registration (bizKey), with the
 *   name normalized: case, punctuation and endings like LLC / Inc are ignored.
 * Keys are one-way (HMAC with FIELD_HASH_KEY); the values themselves are never stored in them.
 */
const { blindIndex } = require('./crypto');

const str = v => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

// "O'Brien-Smith Jr." -> "obriensmith"; letters only, so punctuation and spacing differences don't matter.
const lastNameKey = last => str(last).toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z]/g, '');

const personKey = (dob, last) => blindIndex(`person:v2:${dob}:${lastNameKey(last)}`);

// US mobile numbers to E.164 (+1XXXXXXXXXX); null if it isn't a usable number.
function normPhone(raw) {
  const s = str(raw);
  if (!s) return null;
  let d = s.replace(/\D/g, '');
  if (d.length === 10) d = `1${d}`;
  if (s.startsWith('+') ? d.length >= 8 && d.length <= 15 : d.length === 11 && d[0] === '1') return `+${d}`;
  return null;
}

// Legal-form endings only, so "Acme Company" and "Acme" stay different names.
const SUFFIXES = new Set(['llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'ltd', 'limited', 'lp', 'llp', 'pllc', 'pc', 'pa', 'plc']);
// "The Joe's Café, L.L.C." -> "joes cafe"
function bizNameKey(name) {
  const words = str(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[.'\u2019`]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .split(' ').filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  if (words.length > 1 && words[0] === 'the') words.shift();
  return words.join(' ');
}

const einKey = ein => blindIndex(`ein:${ein}`);
const bizKey = (state, name) => blindIndex(`biz:${String(state).toUpperCase()}:${bizNameKey(name)}`);

module.exports = { lastNameKey, personKey, normPhone, bizNameKey, einKey, bizKey };
