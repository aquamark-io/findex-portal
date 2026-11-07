/**
 * Admin session for /admin. One user: the password is ADMIN_PASSWORD.
 * Separate cookie from account sessions (fx_admin, path /admin, SameSite=Strict), and the token
 * carries scope "admin", so an account session can never pass as admin.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const COOKIE = 'fx_admin';
const MAX_AGE = 12 * 60 * 60 * 1000; // 12 hours

function passwordOk(given) {
  const want = process.env.ADMIN_PASSWORD || '';
  if (!want || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

function setSession(res) {
  const token = jwt.sign({ scope: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h', audience: 'fx-admin' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/admin',
    maxAge: MAX_AGE,
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/admin' });
}

function requireAdmin(req, res, next) {
  const token = req.cookies[COOKIE];
  try {
    if (token && jwt.verify(token, process.env.JWT_SECRET, { audience: 'fx-admin' }).scope === 'admin') return next();
  } catch (e) { /* expired or invalid */ }
  clearSession(res);
  return res.redirect('/admin/login');
}

// Lockout: 8 failed logins per IP in 15 minutes.
const failures = new Map();
function tooManyFailures(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  if (list.length) failures.set(ip, list); else failures.delete(ip);
  return list.length >= 8;
}
function recordFailure(ip) {
  failures.set(ip, [...(failures.get(ip) || []), Date.now()]);
}

module.exports = { requireAdmin, passwordOk, setSession, clearSession, tooManyFailures, recordFailure };
