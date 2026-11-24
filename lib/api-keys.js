/**
 * API keys for the default-search API.
 *   Format: fdx_ + 40 random characters (base64url). Shown once when created; only an HMAC is stored.
 *   key_prefix (first 10 characters, e.g. "fdx_Ab12Cd") lets an admin recognize a key without revealing it.
 */
const crypto = require('crypto');
const supabase = require('./supabase');
const { apiKeyHash } = require('./crypto');

const KEY_RE = /^fdx_[A-Za-z0-9_-]{40}$/;

function newKey() {
  const key = `fdx_${crypto.randomBytes(30).toString('base64url')}`;
  return { key, prefix: key.slice(0, 10), hash: apiKeyHash(key) };
}

async function createKey(accountId, label) {
  const { key, prefix, hash } = newKey();
  const { data, error } = await supabase.from('fx_api_keys')
    .insert({ account_id: accountId, label, key_prefix: prefix, key_hash: hash }).select('id, label, key_prefix, created_at').single();
  if (error) throw new Error(`Create API key: ${error.message}`);
  return { ...data, key };
}

async function listKeys(accountId) {
  const { data, error } = await supabase.from('fx_api_keys')
    .select('id, label, key_prefix, created_at, last_used_at, revoked_at').eq('account_id', accountId).order('created_at', { ascending: false });
  if (error) throw new Error(`List API keys: ${error.message}`);
  return data || [];
}

async function revokeKey(accountId, keyId) {
  const { data, error } = await supabase.from('fx_api_keys').update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId).eq('account_id', accountId).is('revoked_at', null).select('id, label, key_prefix').maybeSingle();
  if (error) throw new Error(`Revoke API key: ${error.message}`);
  return data;
}

/** The live key and its approved company account for an Authorization header, or null. */
async function authenticate(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  if (!m || !KEY_RE.test(m[1])) return null;
  const { data: k, error } = await supabase.from('fx_api_keys')
    .select('id, account_id, revoked_at').eq('key_hash', apiKeyHash(m[1])).maybeSingle();
  if (error) throw new Error(`API key lookup: ${error.message}`);
  if (!k || k.revoked_at) return null;
  const { data: account, error: aErr } = await supabase.from('fx_accounts')
    .select('id, account_type, status, terms_version, business_legal_name').eq('id', k.account_id).maybeSingle();
  if (aErr) throw new Error(`API account lookup: ${aErr.message}`);
  // Same bar as portal search: an approved company that accepted the member terms.
  if (!account || account.status !== 'approved' || account.account_type !== 'company' || !account.terms_version) return null;
  return { key: k, account };
}

module.exports = { KEY_RE, newKey, createKey, listKeys, revokeKey, authenticate };
