/**
 * Postmark webhooks. Set POSTMARK_WEBHOOK_TOKEN in Render and add a Bounce webhook in Postmark pointing to
 *   https://app.joinfindex.com/webhooks/postmark?token=<that value>
 * Postmark sends bounces for every app on the server; anything that isn't a FinDex notice is ignored.
 */
const crypto = require('crypto');
const express = require('express');
const { handleBounce } = require('../lib/notices');

const router = express.Router();

function tokenOk(given) {
  const want = process.env.POSTMARK_WEBHOOK_TOKEN || '';
  if (!want || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

router.post('/webhooks/postmark', express.json({ limit: '200kb' }), async (req, res) => {
  if (!tokenOk(req.query.token)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const result = req.body && req.body.RecordType === 'Bounce' ? await handleBounce(req.body) : 'ignored';
    return res.json({ ok: true, result });
  } catch (err) {
    console.error('Postmark webhook failed:', err.message);
    return res.status(500).json({ error: 'failed' }); // Postmark retries
  }
});

module.exports = router;
