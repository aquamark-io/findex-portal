/**
 * Admin session for /admin. Named admins (fx_admins) sign in with an emailed one-time code.
 *
 * ADMIN_OWNER_EMAIL (Render) is the way in for the first admin: that address can always request a code, its
 * fx_admins row is created on first sign-in, and it can't be disabled from the app.
 * (The old shared ADMIN_PASSWORD sign-in has been removed; it is no longer read.)
 *
 * Separate cookies from account sessions (path /admin, SameSite=Strict), and the token's audience is "fx-admin",
 * so an account session can never pass as admin. The admin row is re-checked on every request, so disabling an
 * admin ends their access at once.
 */
const jwt = require('jsonwebtoken');
const supabase = require('../lib/supabase');

const COOKIE = 'fx_admin';
const LOGIN_COOKIE = 'fx_admin_login';
const MAX_AGE = 12 * 60 * 60 * 1000; // 12 hours

const secure = () => process.env.NODE_ENV === 'production';
const cookieOpts = maxAge => ({ httpOnly: true, secure: secure(), sameSite: 'strict', path: '/admin', maxAge });

const ownerEmail = () => String(process.env.ADMIN_OWNER_EMAIL || '').trim().toLowerCase();
const isOwner = admin => Boolean(admin && admin.email && ownerEmail() && admin.email === ownerEmail());

function setSession(res, admin) {
  const token = jwt.sign({ scope: 'admin', sub: admin.id }, process.env.JWT_SECRET, { expiresIn: '12h', audience: 'fx-admin' });
  res.cookie(COOKIE, token, cookieOpts(MAX_AGE));
}

function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/admin' });
}

function readSession(req) {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  try {
    const s = jwt.verify(token, process.env.JWT_SECRET, { audience: 'fx-admin' });
    return s.scope === 'admin' && typeof s.sub === 'string' ? s : null;
  } catch { return null; }
}

function setLoginEmail(res, email) {
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '15m', audience: 'fx-admin-login' });
  res.cookie(LOGIN_COOKIE, token, cookieOpts(15 * 60 * 1000));
}

function readLoginEmail(req) {
  const token = req.cookies[LOGIN_COOKIE];
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET, { audience: 'fx-admin-login' }).email; } catch { return null; }
}

const clearLoginEmail = res => res.clearCookie(LOGIN_COOKIE, { path: '/admin' });

async function currentAdmin(req) {
  const s = readSession(req);
  if (!s) return null;
  if (!/^[0-9a-f-]{36}$/i.test(s.sub)) return null;
  const { data, error } = await supabase.from('fx_admins').select('*').eq('id', s.sub).maybeSingle();
  if (error) throw new Error(`Admin lookup: ${error.message}`);
  return data && data.status === 'active' ? data : null;
}

async function requireAdmin(req, res, next) {
  try {
    const admin = await currentAdmin(req);
    if (!admin) {
      clearSession(res);
      return res.redirect('/admin/login');
    }
    req.admin = admin;
    res.locals.admin = admin;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  requireAdmin, currentAdmin, setSession, clearSession, readSession,
  setLoginEmail, readLoginEmail, clearLoginEmail, ownerEmail, isOwner,
};
