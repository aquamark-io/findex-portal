/**
 * Contact form: GET/POST /contact. Linked from the website's nav and footer and the portal footer.
 * Signed-in members have their name and email filled in and the message linked to their account; otherwise a
 * message is linked to the account whose email matches (the sender is not told whether one exists).
 * Spam: honeypot field + 5 messages per hour per IP.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const supabase = require('../lib/supabase');
const { readSession } = require('../lib/session');
const { TOPICS, createRequest } = require('../lib/contact');

const router = express.Router();

const normEmail = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const validEmail = v => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v);

const view = (res, extra) => res.status(extra.status || 200).render('contact', {
  pageTitle: 'Contact Us', values: {}, errors: {}, sent: null, error: null, TOPICS, ...extra,
});

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => view(res, { status: 429, values: req.body || {}, error: 'Too many messages from this network. Please try again in an hour.' }) });

async function signedIn(req, res) {
  const s = readSession(req);
  if (!s) return null;
  const { data } = await supabase.from('fx_accounts')
    .select('id, account_type, status, first_name, last_name, email, business_legal_name, company_type, terms_version')
    .eq('id', s.sub).maybeSingle();
  if (!data || data.status !== 'approved') return null;
  res.locals.account = data; // member nav in the header
  return data;
}

router.get('/contact', async (req, res, next) => {
  try {
    const me = await signedIn(req, res);
    const topic = Object.hasOwn(TOPICS, req.query.topic) ? req.query.topic : '';
    view(res, { values: me ? { name: `${me.first_name} ${me.last_name}`, email: me.email, topic } : { topic } });
  } catch (err) { next(err); }
});

router.post('/contact', limiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const values = {
      name: String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 100),
      email: String(body.email || '').trim().slice(0, 254),
      topic: String(body.topic || ''),
      message: String(body.message || '').trim().slice(0, 5000),
    };
    if (body.company_fax) return view(res, { sent: { reference: null } }); // honeypot: pretend it worked
    const me = await signedIn(req, res);
    const errors = {};
    const email = normEmail(values.email);
    if (!validEmail(email)) errors.email = 'Please enter a valid email address.';
    if (!Object.hasOwn(TOPICS, values.topic)) errors.topic = 'Please choose a topic.';
    if (values.message.length < 5) errors.message = 'Please tell us how we can help.';
    if (Object.keys(errors).length) return view(res, { status: 422, values, errors });

    let accountId = me ? me.id : null;
    if (!accountId) {
      const { data } = await supabase.from('fx_accounts').select('id').eq('email', email).in('status', ['pending', 'approved']).limit(1).maybeSingle();
      accountId = data ? data.id : null;
    }
    const sent = await createRequest({ accountId, name: values.name, email, topic: values.topic, message: values.message, ip: req.ip });
    return view(res, { sent });
  } catch (err) { next(err); }
});

module.exports = router;
