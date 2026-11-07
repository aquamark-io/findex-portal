# FinDex Portal

Request Access sign-up, admin approval, and passwordless (email code) sign-in for FinDex.
FinDex is independently administered by Aquamark.

Node 20+, Express 4, EJS, Supabase (service role, server-side only), Postmark. Deployed as one Render web service.

## Local development

```bash
npm install
cp .env.example .env   # fill in values
npm run dev
```

`GET /health` returns `{"status":"ok"}`.

## Database

Migrations live in `supabase/migrations/`. Tables are prefixed `fx_`, have RLS enabled with no policies,
and are reachable only through the service role.

## Pages

| Route | Purpose |
|---|---|
| `/request-access` | Company (member) sign-up only |
| `/check-my-record` | "Who are you?" chooser |
| `/check-my-record/individual`, `/company`, `/funded-business` | Sign-up form for that type, with "Signing up as … · Change" |
| `/request-access/received` | Confirmation |

Sign-up rules: server-side validation; emails lowercased; websites stored as their origin; company emails must be on
the website's domain (free providers rejected); one live account per email and per company domain. DOB, SSN last 4 and
EIN are AES-256-GCM encrypted (`FIELD_ENCRYPTION_KEY`) with an HMAC match key (`FIELD_HASH_KEY`), and never appear in
emails, logs or URLs. Anti-spam: honeypot field + rate limits; Cloudflare Turnstile switches on when
`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set.

A first name, last name or business name starting with `[TEST]` marks the request as a test: it is flagged in admin and
can be deleted there. Test requests still email the admin (new request + sign-in activity) unless `TEST_NOTIFICATIONS=false`.

## Sign-in

Passwordless: `/login` takes an email and, only if that account is approved, emails a 6-digit code. The response is
identical either way, and the code is sent after the response so timing doesn't reveal anything. Codes expire in
10 minutes, are single use, stored as an HMAC, allow 5 attempts, and a new code cancels older ones (max 3 per account
per 15 minutes, plus per-IP limits). Success sets a 12-hour `fx_session` JWT cookie; every request re-checks that the
account is still approved, so revoking in `/admin` ends access immediately. Expired codes are purged opportunistically
(at most hourly), so no cron job is needed.

## Admin

`/admin` (password `ADMIN_PASSWORD`): Pending / Approved / Denied lists, details with masked identity
(`***-**-1234`, `**-***1234`, "DOB on file"), Approve / Deny / Revoke with an internal note, and an event history.
Approving and denying send the matching email. `[TEST]` requests can be deleted.

## Reports (phase two, step 1)

Companies with full access submit reports at `/reports/new` (individual, partner, or funded business), with
evidence files stored in the private `fx-evidence` Supabase bucket (25 MB each, up to 10 per report). Categories
are limited by subject type, and slow pay / missed payments / default are funders-only; default reports require
the default notice. Reported parties (`fx_subjects`) are de-duplicated by DOB + SSN last 4, EIN, or website
domain, with identifiers encrypted. Admin reviews at `/admin/reports`: evidence opens through 2-minute signed
links (each open is logged), and rejecting requires a reason that is emailed to the reporter. Accepting (the
10-day notice) is build step 2. Design decisions: `docs/reporting-design.md`.

## Environment variables (Render)

| Variable | Notes |
|---|---|
| `NODE_ENV` | `production` |
| `PORTAL_BASE_URL` | `https://app.joinfindex.com` (used in email links) |
| `MARKETING_SITE_URL` | `https://joinfindex.com/` (logo link) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Aquamark project, service role |
| `POSTMARK_SERVER_TOKEN` | |
| `ONBOARDING_FROM_EMAIL` | `FinDex <christina@aquamark.io>` |
| `ONBOARDING_NOTIFY_EMAIL` | Receives new-request notifications |
| `JWT_SECRET` | Long random string |
| `ADMIN_PASSWORD` | `/admin` password |
| `FIELD_ENCRYPTION_KEY`, `FIELD_HASH_KEY` | Two different long random values (Render's **Generate** button works, or a base64 32-byte key). Keep a copy somewhere safe and never change them once data exists: stored DOB / SSN / EIN can't be read without them. |
| `ADMIN_ACTIVITY_EMAILS` | Optional. Sign-in activity emails to `ONBOARDING_NOTIFY_EMAIL` are on by default; set `false` to turn them off |
| `TEST_NOTIFICATIONS` | Optional. `[TEST]` requests email the admin like real ones; set `false` to keep them silent |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Optional |
