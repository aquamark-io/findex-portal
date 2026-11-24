/**
 * Admin sign-in (mounted on /admin before requireAdmin).
 *
 *   GET/POST /admin/login          enter email (named admins), or the shared password while ADMIN_PASSWORD is set
 *   GET/POST /admin/login/verify   enter the 6-digit code
 *   POST     /admin/login/resend   send a fresh code
 *   POST     /admin/login/password the old shared password (only while ADMIN_PASSWORD is set in Render)
 *   POST     /admin/logout
 *
 * Codes: 6 digits, 10-minute expiry, single use, stored as HMAC, max 5 attempts, a new code cancels older ones,
 * at most 3 codes per admin per 15 minutes, plus per-IP rate limits. The screen never says whether an email
 * belongs to an admin; only active admins (and ADMIN_OWNER_EMAIL) are emailed.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const supabase = require('../lib/supabase');
const admin = require('../middleware/admin');
const { codeHash } = require('../lib/crypto');
const { sendEmail, templates } = require('../lib/email');
const { logAdmin } = require('../lib/audit');

const router = express.Router();

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_WINDOW = 3;
const CODE_WINDOW_MS = 15 * 60 * 1000;
const GENERIC = 'That code is incorrect or has expired. Check the code, or request a new one.';

const normEmail = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const validEmail = v => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v);
const hashFor = (adminId, code) => codeHash(`admin:${adminId}`, code);

const loginPage = (res, status, error, email = '') => res.status(status).render('admin/login', {
  pageTitle: 'Admin Sign In', error, email, adminNav: false, passwordEnabled: admin.passwordEnabled(),
});
const verifyPage = (res, status, error, email, resent = false) => res.status(status).render('admin/verify', {
  pageTitle: 'Admin Sign In', error, email, resent, adminNav: false,
});

const requestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => loginPage(res, 429, 'Too many sign-in requests from this network. Please wait 15 minutes and try again.') });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 25, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => verifyPage(res, 429, 'Too many attempts from this network. Please wait 15 minutes and try again.', '') });

// The active admin for an email. The owner's row is created on their first sign-in.
async function adminForSignIn(email, { create = false } = {}) {
  const { data, error } = await supabase.from('fx_admins').select('*').eq('email', email).maybeSingle();
  if (error) throw new Error(`Admin lookup: ${error.message}`);
  if (data) return data.status === 'active' || email === admin.ownerEmail() ? data : null;
  if (!create || email !== admin.ownerEmail()) return null;
  const { data: made, error: insErr } = await supabase.from('fx_admins')
    .insert({ email, name: email.split('@')[0] }).select('*').single();
  if (insErr) throw new Error(`Create owner admin: ${insErr.message}`);
  return made;
}

// Runs after the response is sent, so timing doesn't reveal whether the email belongs to an admin.
async function issueCode(email, ip) {
  try {
    const a = await adminForSignIn(email, { create: true });
    if (!a) return;
    const since = new Date(Date.now() - CODE_WINDOW_MS).toISOString();
    const { count, error: countErr } = await supabase.from('fx_admin_login_codes')
      .select('id', { count: 'exact', head: true }).eq('admin_id', a.id).gte('created_at', since);
    if (countErr) throw new Error(`Admin code count: ${countErr.message}`);
    if ((count || 0) >= MAX_CODES_PER_WINDOW) return;

    await supabase.from('fx_admin_login_codes').update({ used_at: new Date().toISOString() }).eq('admin_id', a.id).is('used_at', null);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const { error: insErr } = await supabase.from('fx_admin_login_codes').insert({
      admin_id: a.id, code_hash: hashFor(a.id, code), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(), ip,
    });
    if (insErr) throw new Error(`Admin code insert: ${insErr.message}`);
    await sendEmail({ to: a.email, tag: 'fx-admin-sign-in-code', ...templates.adminSignInCode(a, code) });
  } catch (err) {
    console.error('Issuing admin sign-in code failed:', err.message);
  }
}

router.get('/login', async (req, res, next) => {
  try {
    if (await admin.currentAdmin(req)) return res.redirect('/admin');
    loginPage(res, 200, null);
  } catch (err) { next(err); }
});

router.post('/login', requestLimiter, (req, res) => {
  const email = normEmail(req.body.email);
  if (!validEmail(email)) return loginPage(res, 422, 'Please enter a valid email address.', email);
  admin.setLoginEmail(res, email);
  res.redirect(303, '/admin/login/verify');
  setImmediate(() => issueCode(email, req.ip));
});

router.get('/login/verify', (req, res) => {
  const email = admin.readLoginEmail(req);
  if (!email) return res.redirect('/admin/login');
  verifyPage(res, 200, null, email, req.query.resent === '1');
});

router.post('/login/resend', requestLimiter, (req, res) => {
  const email = admin.readLoginEmail(req);
  if (!email) return res.redirect(303, '/admin/login');
  admin.setLoginEmail(res, email);
  res.redirect(303, '/admin/login/verify?resent=1');
  setImmediate(() => issueCode(email, req.ip));
});

router.post('/login/verify', verifyLimiter, async (req, res, next) => {
  const email = admin.readLoginEmail(req);
  if (!email) return res.redirect(303, '/admin/login');
  const code = typeof req.body.code === 'string' ? req.body.code.replace(/\D/g, '') : '';
  const fail = (message, status = 401) => verifyPage(res, status, message, email);
  try {
    if (code.length !== 6) return fail('Please enter the 6-digit code from your email.', 422);
    const a = await adminForSignIn(email);
    if (!a) return fail(GENERIC);

    const { data: row, error } = await supabase.from('fx_admin_login_codes')
      .select('id, code_hash, attempts')
      .eq('admin_id', a.id).is('used_at', null).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`Admin code lookup: ${error.message}`);
    if (!row) return fail(GENERIC);
    if (row.attempts >= MAX_ATTEMPTS) return fail('Too many incorrect attempts. Please request a new code.', 429);

    const given = Buffer.from(hashFor(a.id, code), 'hex');
    const want = Buffer.from(row.code_hash, 'hex');
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      const attempts = row.attempts + 1;
      await supabase.from('fx_admin_login_codes').update({ attempts, ...(attempts >= MAX_ATTEMPTS ? { used_at: new Date().toISOString() } : {}) })
        .eq('id', row.id).eq('attempts', row.attempts);
      await logAdmin(req, 'admin_login_failed', { detail: { method: 'code', attempts } }, a);
      return fail(attempts >= MAX_ATTEMPTS ? 'Too many incorrect attempts. Please request a new code.' : GENERIC);
    }

    // Single use even under concurrent submits.
    const { data: used, error: useErr } = await supabase.from('fx_admin_login_codes')
      .update({ used_at: new Date().toISOString() }).eq('id', row.id).is('used_at', null).select('id').maybeSingle();
    if (useErr) throw new Error(`Admin code use: ${useErr.message}`);
    if (!used) return fail(GENERIC);

    // The owner is always active (a disabled owner row is switched back on by signing in).
    const update = { last_login_at: new Date().toISOString(), ...(a.status !== 'active' ? { status: 'active' } : {}) };
    await supabase.from('fx_admins').update(update).eq('id', a.id);
    await logAdmin(req, 'admin_login', { detail: { method: 'code' } }, a);
    admin.clearLoginEmail(res);
    admin.setSession(res, a);
    return res.redirect(303, '/admin');
  } catch (err) { return next(err); }
});

router.post('/login/password', async (req, res, next) => {
  try {
    const ip = req.ip;
    if (!admin.passwordEnabled()) return loginPage(res, 410, 'Password sign-in is turned off. Sign in with your email instead.');
    if (admin.tooManyFailures(ip)) return loginPage(res, 429, 'Too many attempts. Try again in 15 minutes.');
    if (!admin.passwordOk(req.body.password)) {
      admin.recordFailure(ip);
      await logAdmin(req, 'admin_login_failed', { detail: { method: 'password' } }, admin.PASSWORD_ADMIN);
      return loginPage(res, 401, 'Incorrect password.');
    }
    await logAdmin(req, 'admin_login', { detail: { method: 'password' } }, admin.PASSWORD_ADMIN);
    admin.setSession(res, null);
    res.redirect(303, '/admin');
  } catch (err) { next(err); }
});

router.post('/logout', async (req, res, next) => {
  try {
    const a = await admin.currentAdmin(req);
    admin.clearSession(res);
    if (a) await logAdmin(req, 'admin_logout', {}, a);
    res.redirect(303, '/admin/login');
  } catch (err) { next(err); }
});

module.exports = router;
