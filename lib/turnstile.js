/**
 * Cloudflare Turnstile hook. Off until TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set;
 * the form then renders the widget and verify() checks the token server-side.
 */
const enabled = () => Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);

async function verify(token, ip) {
  if (!enabled()) return true;
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip || '' }),
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('Turnstile verify failed:', err.message);
    return false;
  }
}

module.exports = { enabled, verify, siteKey: () => process.env.TURNSTILE_SITE_KEY || '' };
