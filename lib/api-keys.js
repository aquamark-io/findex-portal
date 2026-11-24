/**
 * API access and keys for the default-search API.
 *   Access (fx_api_access, one row per company): requested from the dashboard -> approved / denied by an admin ->
 *   revoked if needed. Only approved companies can create keys, and only the company ever sees its keys.
 *   Format: fdx_ + 40 random characters (base64url). Shown once when created; only an HMAC is stored.
 *   key_prefix (first 10 characters, e.g. "fdx_Ab12Cd") lets an admin recognize a key without revealing it.
 */
const crypto = require('crypto');
const supabase = require('./supabase');
const { apiKeyHash } = require('./crypto');

const KEY_RE = /^fdx_[A-Za-z0-9_-]{40}$/;
const MAX_ACTIVE_KEYS = 5;
const ACCESS_LABELS = { requested: 'Requested', approved: 'Approved', denied: 'Not approved', revoked: 'Turned off' };

// Same bar as portal search: an approved company that accepted the member terms.
const canUseApi = a => Boolean(a && a.account_type === 'company' && a.status === 'approved' && a.terms_version);

async function getAccess(accountId) {
  const { data, error } = await supabase.from('fx_api_access').select('*').eq('account_id', accountId).maybeSingle();
  if (error) throw new Error(`API access: ${error.message}`);
  return data;
}

/** Creates or renews a request. Returns the row, or null if access is already requested or approved. */
async function requestAccess(accountId, useNote) {
  const current = await getAccess(accountId);
  if (current && ['requested', 'approved'].includes(current.status)) return null;
  const row = { status: 'requested', use_note: useNote || null, requested_at: new Date().toISOString(), decided_at: null, decision_note: null };
  const q = current
    ? supabase.from('fx_api_access').update(row).eq('account_id', accountId).eq('status', current.status)
    : supabase.from('fx_api_access').insert({ account_id: accountId, ...row });
  const { data, error } = await q.select('*').maybeSingle();
  if (error) { if (error.code === '23505') return null; throw new Error(`Request API access: ${error.message}`); }
  return data;
}

/** Admin decision. `from` lists the statuses it may change from; returns the updated row or null if it changed. */
async function decideAccess(accountId, status, from, note) {
  const { data, error } = await supabase.from('fx_api_access')
    .update({ status, decided_at: new Date().toISOString(), decision_note: note || null })
    .eq('account_id', accountId).in('status', from).select('*').maybeSingle();
  if (error) throw new Error(`API access decision: ${error.message}`);
  if (data && status !== 'approved') {
    await supabase.from('fx_api_keys').update({ revoked_at: new Date().toISOString() }).eq('account_id', accountId).is('revoked_at', null);
  }
  return data;
}

function newKey() {
  const key = `fdx_${crypto.randomBytes(30).toString('base64url')}`;
  return { key, prefix: key.slice(0, 10), hash: apiKeyHash(key) };
}

async function createKey(accountId, label) {
  const { count, error: cErr } = await supabase.from('fx_api_keys').select('id', { count: 'exact', head: true }).eq('account_id', accountId).is('revoked_at', null);
  if (cErr) throw new Error(`Count API keys: ${cErr.message}`);
  if ((count || 0) >= MAX_ACTIVE_KEYS) return { tooMany: true };
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
  if (!canUseApi(account)) return null;
  const access = await getAccess(account.id);
  if (!access || access.status !== 'approved') return null;
  return { key: k, account };
}

module.exports = { KEY_RE, MAX_ACTIVE_KEYS, ACCESS_LABELS, canUseApi, getAccess, requestAccess, decideAccess, newKey, createKey, listKeys, revokeKey, authenticate };
