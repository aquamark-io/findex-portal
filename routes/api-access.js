/**
 * API access for companies (members with full access).
 *   GET  /api-access                       status, request form, or (once approved) your keys
 *   POST /api-access/request               request API access (emails the admin)
 *   POST /api-access/keys                  create a key: shown once, on this response only
 *   POST /api-access/keys/:keyId/revoke    revoke one of your keys
 * Only the company ever sees its keys; FinDex stores an HMAC.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAccount } = require('../middleware/auth');
const K = require('../lib/api-keys');
const { sendEmail, apiEmails } = require('../lib/email');
const { logEvent } = require('../lib/events');
const { testNotificationsOn } = require('../lib/notify-admin');

const router = express.Router();

const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => (req.account ? `acct:${req.account.id}` : req.ip),
  handler: (req, res) => res.status(429).render('error', { pageTitle: 'Too many requests', message: 'Too many changes in a short time. Please try again later.' }),
});

const clean = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const fmt = d => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) : '');
const docsUrl = () => `${(process.env.MARKETING_SITE_URL || 'https://joinfindex.com/').replace(/\/$/, '')}/api/`;
const MESSAGES = {
  requested: 'Request sent. We’ll email you once it has been reviewed.',
  revoked: 'Key revoked. It stopped working immediately.',
};

router.use('/api-access', requireAccount, (req, res, next) => {
  if (!K.canUseApi(req.account)) return res.redirect('/dashboard');
  return next();
});

async function render(req, res, extra = {}) {
  const access = await K.getAccess(req.account.id);
  const keys = access && access.status === 'approved' ? await K.listKeys(req.account.id) : [];
  res.set('Cache-Control', 'no-store');
  res.status(extra.status || 200).render('api-access', {
    pageTitle: 'API access', access, keys, newKey: null, error: null, fmt, docsUrl: docsUrl(),
    maxKeys: K.MAX_ACTIVE_KEYS, ACCESS_LABELS: K.ACCESS_LABELS,
    msg: MESSAGES[req.query.done] || null,
    ...extra,
  });
}

router.get('/api-access', async (req, res, next) => {
  try { await render(req, res); } catch (err) { next(err); }
});

router.post('/api-access/request', writeLimiter, async (req, res, next) => {
  try {
    const note = clean(req.body.use_note, 1000);
    const row = await K.requestAccess(req.account.id, note);
    if (!row) return res.redirect(303, '/api-access');
    await logEvent({ accountId: req.account.id, event: 'api_access_requested', actor: 'account', ip: req.ip });
    const a = req.account;
    if (process.env.ONBOARDING_NOTIFY_EMAIL && (!a.is_test || testNotificationsOn())) {
      await sendEmail({ to: process.env.ONBOARDING_NOTIFY_EMAIL, tag: 'fx-admin-api-request', ...apiEmails.adminRequest(a, note) })
        .catch(err => console.error('API request admin email failed:', err.message));
    }
    return res.redirect(303, '/api-access?done=requested');
  } catch (err) { return next(err); }
});

router.post('/api-access/keys', writeLimiter, async (req, res, next) => {
  try {
    const access = await K.getAccess(req.account.id);
    if (!access || access.status !== 'approved') return res.redirect(303, '/api-access');
    const label = clean(req.body.label, 100) || 'API key';
    const created = await K.createKey(req.account.id, label);
    if (created.tooMany) return render(req, res, { status: 422, error: `You can have up to ${K.MAX_ACTIVE_KEYS} active keys. Revoke one you no longer use first.` });
    await logEvent({ accountId: req.account.id, event: 'api_key_created', actor: 'account', detail: { key_id: created.id, prefix: created.key_prefix }, ip: req.ip });
    return render(req, res, { newKey: created });
  } catch (err) { return next(err); }
});

router.post('/api-access/keys/:keyId/revoke', writeLimiter, async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.keyId)) return res.redirect(303, '/api-access');
    const revoked = await K.revokeKey(req.account.id, req.params.keyId);
    if (revoked) await logEvent({ accountId: req.account.id, event: 'api_key_revoked', actor: 'account', detail: { key_id: revoked.id, prefix: revoked.key_prefix }, ip: req.ip });
    return res.redirect(303, revoked ? '/api-access?done=revoked' : '/api-access');
  } catch (err) { return next(err); }
});

module.exports = router;
