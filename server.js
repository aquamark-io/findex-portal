require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const path = require('path');

const { checkKeys } = require('./lib/crypto');
const turnstile = require('./lib/turnstile');

// Refuse to start without valid field-encryption keys rather than fail on the first sign-up.
checkKeys();
for (const name of ['JWT_SECRET']) {
  if (!process.env[name] || process.env[name].length < 32) throw new Error(`${name} must be set (32+ characters)`);
}

const app = express();

// Render sits behind one proxy; needed for req.ip and rate limiting.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", ...(turnstile.enabled() ? ['https://challenges.cloudflare.com'] : [])],
      'frame-src': turnstile.enabled() ? ['https://challenges.cloudflare.com'] : ["'none'"],
      'connect-src': ["'self'", ...(turnstile.enabled() ? ['https://challenges.cloudflare.com'] : [])],
      'style-src': ["'self'"],
      'font-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    },
  },
}));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Changes on every deploy so browsers fetch fresh CSS/JS (Render sets RENDER_GIT_COMMIT).
const ASSET_VERSION = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 12);

app.use((req, res, next) => {
  res.locals.assetV = ASSET_VERSION;
  res.locals.currentPath = req.originalUrl.split('?')[0];
  res.locals.marketingUrl = process.env.MARKETING_SITE_URL || 'https://joinfindex.com/';
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/', (req, res) => res.redirect('/login'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/', require('./routes/reports'));
app.use('/', require('./routes/access'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { pageTitle: 'Not found', message: 'That page does not exist.' }));

app.use((err, req, res, next) => {
  // Never log request bodies: they can contain DOB / SSN / EIN.
  console.error(`Error on ${req.method} ${req.path}:`, err.message);
  res.status(500).render('error', { pageTitle: 'Something went wrong', message: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FinDex portal running on port ${PORT}`));
