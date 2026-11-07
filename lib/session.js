/**
 * Account session (fx_session) and the short-lived "which email is signing in" cookie (fx_login).
 * Both are signed JWTs in httpOnly cookies; the email is never put in a URL.
 */
const jwt = require('jsonwebtoken');

const SESSION_COOKIE = 'fx_session';
const SESSION_HOURS = 12;
const LOGIN_COOKIE = 'fx_login';
const LOGIN_MINUTES = 15;

const secure = () => process.env.NODE_ENV === 'production';

function setSession(res, account) {
  const token = jwt.sign({ sub: account.id, typ: account.account_type, ct: account.company_type || undefined },
    process.env.JWT_SECRET, { expiresIn: `${SESSION_HOURS}h`, audience: 'fx-session' });
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/', maxAge: SESSION_HOURS * 3600 * 1000 });
}

function readSession(req) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET, { audience: 'fx-session' }); } catch { return null; }
}

const clearSession = res => res.clearCookie(SESSION_COOKIE, { path: '/' });

function setLoginEmail(res, email) {
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: `${LOGIN_MINUTES}m`, audience: 'fx-login' });
  res.cookie(LOGIN_COOKIE, token, { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/login', maxAge: LOGIN_MINUTES * 60 * 1000 });
}

function readLoginEmail(req) {
  const token = req.cookies[LOGIN_COOKIE];
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET, { audience: 'fx-login' }).email; } catch { return null; }
}

const clearLoginEmail = res => res.clearCookie(LOGIN_COOKIE, { path: '/login' });

module.exports = { setSession, readSession, clearSession, setLoginEmail, readLoginEmail, clearLoginEmail };
