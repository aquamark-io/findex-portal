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
can be deleted there. Test requests still email the admin (new request) unless `TEST_NOTIFICATIONS=false`.

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
are limited by subject type, and missed payments / default are funders and lenders only; default reports require
the default notice. Reported parties (`fx_subjects`) are de-duplicated by DOB + SSN last 4, EIN, or website
domain, with identifiers encrypted. Admin reviews at `/admin/reports`: evidence opens through 2-minute signed
links (each open is logged), and rejecting requires a reason that is emailed to the reporter. Accepting emails the
notice to the reported party (naming the reporter; individuals also get the CFPB Summary of Rights link) and starts
10 days. Bounces come back through the Postmark webhook: the report pauses and the reporter gives another email address
(no mailed letters; a report never publishes without a delivered notice). A daily job after 6 AM
Pacific publishes reports whose 10 days have passed. Reported parties are linked to their own accounts automatically
(same notice email, DOB + SSN last 4, EIN, or company domain) or by the admin, and see their reports and evidence on
the dashboard. Design decisions: `docs/reporting-design.md`.

## Search (phase two, step 3)

Companies with full access search at `/search`. Individuals need a full name plus email and/or DOB (optionally with SSN
last 4), and every identifier given must match; partners match by website domain or name; funded businesses need legal
name and EIN (the EIN decides). Each search records a permissible purpose and a certification; employment screening
also requires the employment certification and an uploaded signed authorization. Results show published reports only,
with evidence (signed, logged), and stay viewable for 7 days. Every search is logged in `fx_searches` without DOB, SSN
or EIN values; reported parties see "Who has viewed your record", and admin has a Search log. Limit: 60 searches per
hour per company.

## AI evidence review

When a report is submitted (and on demand from the admin report page), Claude (`claude-opus-5-5`) reads the evidence
files and writes a structured summary: what each file shows, five checks (matches the party, supports the incident,
dates consistent, required documents present, evidence quality) answered yes / no / unclear with citations, concerns,
and anything missing. It never accepts, rejects or publishes. Only the last 4 digits of an EIN or SSN are sent. Results
are stored in `fx_evidence_reviews` with the model and prompt version. Off unless `ANTHROPIC_API_KEY` is set.

## Disputes (phase two, step 4)

A reported party disputes from their dashboard (reason + optional files). The report is withheld at once (out of
search results and the publishing job), and a 30-day due date is set. The reporter sees the dispute on their report
page and responds with text and files. Admin works the Disputes queue (due dates, overdue
flagged) and resolves each one as upheld (published), amended (published with a corrected
description) or removed. The resolution note is emailed to both sides.

## Retention and member notices (phase two, step 5)

The daily job also permanently deletes reports whose incident is more than 7 years old (`expires_on`), with their
evidence, notices and dispute files; reports with an open dispute wait until it is resolved. Companies accept the
CFPB Notice to Users and Notice to Furnishers (linked) together with the indemnification terms.

## Daily job

Runs once a day after 6 AM Pacific (checked every 15 minutes; logged as `daily_job` so it runs once): publishes reports
past their 10-day notice and deletes expired reports. Set `DISABLE_DAILY_JOB=true` to turn it
off (e.g. in tests).

## Environment variables (Render)

| Variable | Notes |
|---|---|
| `NODE_ENV` | `production` |
| `PORTAL_BASE_URL` | `https://app.joinfindex.com` (used in email links) |
| `MARKETING_SITE_URL` | `https://joinfindex.com/` (logo link) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Aquamark project, service role |
| `POSTMARK_SERVER_TOKEN` | |
| `ONBOARDING_FROM_EMAIL` | `FinDex <christina@aquamark.io>` |
| `ONBOARDING_NOTIFY_EMAIL` | Admin email. Receives only: new access requests, new reports, new disputes, and customer changes to a report or dispute (dispute response, report removed, payment status updated, new notice email) |
| `JWT_SECRET` | Long random string |
| `ADMIN_PASSWORD` | `/admin` password |
| `FIELD_ENCRYPTION_KEY`, `FIELD_HASH_KEY` | Two different long random values (Render's **Generate** button works, or a base64 32-byte key). Keep a copy somewhere safe and never change them once data exists: stored DOB / SSN / EIN can't be read without them. |
| `ANTHROPIC_API_KEY` | Optional. Turns on the Claude evidence review in admin (an aid; admins still decide) |
| `POSTMARK_WEBHOOK_TOKEN` | Long random value. Postmark's Bounce webhook calls `https://app.joinfindex.com/webhooks/postmark?token=<value>` |
| `TEST_NOTIFICATIONS` | Optional. `[TEST]` requests email the admin like real ones; set `false` to keep them silent |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Optional |
