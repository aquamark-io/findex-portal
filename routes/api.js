/**
 * Funded Business API (approved companies; access approved by an admin, keys created by the company).
 *   POST /api/v1/funded-business   JSON { "ein": "12-3456789" }  or  { "name": "Joe's Cafe LLC", "state": "TX" },
 *                                  plus optional "checks": ["default", "document_tampering"] (both when omitted)
 *   POST /api/v1/defaults          same, with "checks" defaulting to ["default"] (the original endpoint)
 * Each check returns whether anything is on record and, per report, the date and the reporting company. The
 * reporter's description and evidence stay in the portal (results_url), which shows only the checks requested.
 *   GET  /api               redirects to the documentation on the marketing site (joinfindex.com/api/)
 * Same matching and privacy as a portal search of a funded business: only published reports, the EIN is never
 * stored (one-way keys only), and every lookup is logged as a search by the key's company.
 * The EIN goes in the request body, never the URL, so it stays out of access logs.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const supabase = require('../lib/supabase');
const S = require('../lib/search');
const K = require('../lib/api-keys');

const router = express.Router();
const PER_HOUR = 300;
const BASE = () => (process.env.PORTAL_BASE_URL || 'https://app.joinfindex.com').replace(/\/$/, '');

const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });

// Wrong or missing keys, per IP, so keys can't be guessed.
const authFailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  skipSuccessfulRequests: true, requestWasSuccessful: (req, res) => res.statusCode !== 401,
  handler: (req, res) => fail(res, 429, 'too_many_attempts', 'Too many failed requests. Try again later.'),
});
// Lookups, per key.
const keyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: PER_HOUR, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => `key:${req.apiKey.id}`,
  handler: (req, res) => fail(res, 429, 'rate_limited', `This key has reached its limit of ${PER_HOUR} lookups per hour.`),
});

async function requireKey(req, res, next) {
  try {
    const auth = await K.authenticate(req.get('authorization'));
    if (!auth) {
      return fail(res, 401, 'invalid_key', 'Missing, invalid, or revoked API key. Send it as: Authorization: Bearer fdx_...');
    }
    req.apiKey = auth.key;
    req.account = auth.account;
    return next();
  } catch (err) { return next(err); }
}

const json = express.json({ limit: '4kb', strict: true, type: () => true });

// API check name -> report category. ("fraud" is the internal code for document tampering.)
const CHECKS = { default: 'default', document_tampering: 'fraud' };

function parseChecks(raw, fallback) {
  if (raw === undefined || raw === null) return { checks: fallback };
  const list = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list) || !list.length || list.some(c => typeof c !== 'string' || !CHECKS[c])) {
    return { error: `"checks" must be a list containing "default", "document_tampering", or both.` };
  }
  return { checks: [...new Set(list)] };
}

const lookup = defaultChecks => async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const input = { ein: typeof body.ein === 'string' ? body.ein : '', name: typeof body.name === 'string' ? body.name : '',
      state: typeof body.state === 'string' ? body.state : '', certify: 'on' };
    const { errors, q } = S.validateSearch(input, 'merchant');
    const parsed = parseChecks(body.checks, defaultChecks);
    if (parsed.error) errors.push(parsed.error);
    if (errors.length) return fail(res, 422, 'invalid_request', errors.join(' '));
    const { checks } = parsed;

    const found = await S.findSubjects('merchant', q);
    const wanted = new Set(checks.map(c => CHECKS[c]));
    const reports = (await S.publishedReportsFor(found.ids)).filter(r => wanted.has(r.category));
    const activity = await S.recentActivity(found.keys, req.account.id);

    // Only the requested checks are logged, so results_url shows exactly what this lookup returned.
    const searchId = crypto.randomUUID();
    const { error: lErr } = await supabase.from('fx_searches').insert({
      id: searchId, account_id: req.account.id, subject_type: 'merchant', purpose: q.purpose,
      criteria: { ...S.criteriaForLog(q), matched: found.matched, via: 'api', checks }, subject_keys: found.keys,
      matched_subject_ids: found.ids, result_report_ids: reports.map(r => r.id), api_key_id: req.apiKey.id,
      certified_at: new Date().toISOString(), ip: req.ip,
    });
    if (lErr) throw new Error(`Log API search: ${lErr.message}`);
    await supabase.from('fx_api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', req.apiKey.id);

    const out = {};
    for (const c of checks) {
      const list = reports.filter(r => r.category === CHECKS[c]);
      out[c] = {
        on_record: list.length > 0,
        reports: list.map(r => ({
          incident_date: r.incident_date,
          published_on: r.published_at ? String(r.published_at).slice(0, 10) : null,
          reported_by: r.reporter ? r.reporter.business_legal_name : null,
        })),
      };
    }
    res.set('Cache-Control', 'no-store');
    return res.json({
      search_id: searchId,
      searched_by: q.ein ? 'ein' : 'name_state',
      checks: out,
      recent_searches: { days: 30, companies: activity.companies, searches: activity.searches },
      results_url: `${BASE()}/search/results/${searchId}`,
    });
  } catch (err) { return next(err); }
};

router.post('/api/v1/funded-business', authFailLimiter, requireKey, keyLimiter, json, lookup(['default', 'document_tampering']));
router.post('/api/v1/defaults', authFailLimiter, requireKey, keyLimiter, json, lookup(['default']));

// Anything else under /api/v1 gets a JSON 404, not the HTML page.
router.all('/api/v1/*', (req, res) => fail(res, 404, 'not_found', `Unknown endpoint. See ${DOCS_URL()} for the documentation.`));

// The documentation lives on the marketing site.
const DOCS_URL = () => `${(process.env.MARKETING_SITE_URL || 'https://joinfindex.com/').replace(/\/$/, '')}/api/`;
router.get('/api', (req, res) => res.redirect(301, DOCS_URL()));

// JSON errors for the API (bad JSON body, unexpected failures).
// eslint-disable-next-line no-unused-vars
router.use('/api/v1', (err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'invalid_json', 'The request body must be JSON.');
  if (err.type === 'entity.too.large') return fail(res, 413, 'too_large', 'The request body is too large.');
  console.error(`API error on ${req.method} ${req.path}:`, err.message);
  return fail(res, 500, 'server_error', 'Something went wrong. Please try again.');
});

module.exports = router;
