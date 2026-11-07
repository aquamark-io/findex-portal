/**
 * Field-level protection for sensitive identity data (DOB, SSN last 4, EIN).
 *
 *  - encrypt()/decrypt(): AES-256-GCM with FIELD_ENCRYPTION_KEY (32 bytes, base64).
 *    Stored as "v1:<iv>:<tag>:<ciphertext>" (base64 parts) so the key can be rotated later.
 *  - blindIndex(): HMAC-SHA256 with FIELD_HASH_KEY, for matching without decrypting.
 *  - codeHash(): HMAC for one-time sign-in codes (a plain hash of a 6-digit code is brute-forceable).
 *
 * Never log inputs or outputs of these functions.
 */
const crypto = require('crypto');

function loadKey(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set`);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
  return key;
}

let encKey, hashKey;
const getEncKey = () => (encKey ||= loadKey('FIELD_ENCRYPTION_KEY'));
const getHashKey = () => (hashKey ||= loadKey('FIELD_HASH_KEY'));

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncKey(), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

function decrypt(payload) {
  if (!payload) return null;
  const [version, iv, tag, data] = String(payload).split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognized ciphertext format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

function hmac(purpose, value) {
  return crypto.createHmac('sha256', getHashKey()).update(`${purpose}\u0000${value}`).digest('hex');
}

const blindIndex = value => hmac('identity', value);
const codeHash = (accountId, code) => hmac('login-code', `${accountId}:${code}`);

// Fail fast at boot instead of on the first sign-up.
function checkKeys() {
  getEncKey();
  getHashKey();
}

module.exports = { encrypt, decrypt, blindIndex, codeHash, checkKeys };
