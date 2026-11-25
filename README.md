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
| `/check-my-record/individual`, `/company`, `/merchant` | Sign-up form for that type, with "Signing up as … · Change" |
| `/request-access/received` | Confirmation |

Sign-up rules: server-side validation; emails lowercased; websites stored as their origin; company emails must be on
the website's domain (free providers rejected); one live account per email and per company domain. FinDex does not collect any part of an SSN. DOB and
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

`/admin`: Pending / Approved / Denied lists, details with masked identity
(`**-***1234`, "DOB on file"), Approve / Deny / Revoke with an internal note, and an event history.
Approving and denying send the matching email. `[TEST]` requests can be deleted.

**Sign-in.** Named admins (`fx_admins`) sign in at `/admin/login` with a 6-digit code emailed to them (10-minute
expiry, single use, 5 attempts, 3 codes per 15 minutes). The email in `ADMIN_OWNER_EMAIL` can always sign in (its row
is created on first sign-in) and can't be disabled from the app. There is no shared password (the old
`ADMIN_PASSWORD` sign-in was removed). If Postmark is ever down, there is no way in until email works again.

**Settings** (`/admin/settings`): add admins (name + email), disable, re-enable, rename. Nobody can disable
themselves or the owner. Admins are disabled, never deleted, so their names stay on the audit log.

**Audit log** (`/admin/audit`, `fx_admin_audit`): every admin action with the admin, action, target, time and IP:
sign-in/out and failed sign-ins, account approve/deny/revoke, report accept/reject, dispute decisions (upheld and
amended publish the report; removed removes it), API access decisions and key revokes, evidence / dispute /
authorization file opens, AI review, linking, test deletes, admin changes, and checklist test emails. Filter by admin,
action and date (Pacific). A database trigger rejects every update, delete and truncate, so entries can't be edited
or removed, even with the service key. If an entry can't be written, the request fails: file opens and sign-ins are
recorded before they happen, changes right after. `fx_events` still records admin actions for each record's History.

**Launch checklist** (`/admin/launch`): pass / fail for required Render settings (names only), production mode,
Postmark accepting the token (plus a "Send a test email" button), the daily job
having run today, no test or old-format records, and a final (non-draft) member terms version.

## Activity

`/activity` (nav: Activity; replaces the old Reports list, and `/reports` and `/reports/about` redirect here) has three tabs:
reports you submitted, reports about your company (with disputes), and your searches. Until a member has their own,
each tab shows clickable example rows (fictional sample data in `lib/report-examples.js`) that open sample pages at
`/activity/example/:n` or `/search/example/:who`. Submitting a report starts from the button in the Activity header.

## Contact form

`/contact` (linked from the website nav and footer and the portal footer): name, email, topic, message. Each message
is saved in `fx_contact_requests` with a reference like `FX-7F3A21`; the sender gets a confirmation email and
`ONBOARDING_NOTIFY_EMAIL` gets an alert with the topic and reference only, never the message text. Signed-in members
have their details filled in and the message linked to their account; otherwise it is linked to the account with that
email (the sender isn't told). Spam: honeypot + 5 messages per hour per IP. Admins work the queue at `/admin/contact`
(open / in progress / closed, internal note, reply by email); opening a message and changing it are in the audit log.

## Reports (phase two, step 1)

Companies with full access submit reports at `/reports/new` (individual, vendor, or merchant, a business that applied for or received funding; vendors pick a vendor type, `fx_subjects.vendor_type`), with
evidence files stored in the private `fx-evidence` Supabase bucket (25 MB each, up to 10 per report). Categories
are limited by subject type, and default is funders and lenders only; default reports require
the default notice and must be filed within 90 days of the default date (other incidents: within 7 years). Reported parties (`fx_subjects`) are de-duplicated by EIN (businesses), website domain (vendors), or, for people,
DOB + last name plus a matching email or mobile (`lib/identity.js`), with identifiers encrypted or kept as one-way keys. Admin reviews at `/admin/reports`: evidence opens through 2-minute signed
links (each open is logged), and rejecting requires a reason that is emailed to the reporter. Accepting emails the
notice to the reported party (naming the reporter; individuals also get the CFPB Summary of Rights link) and starts
10 days. Bounces come back through the Postmark webhook: the report pauses and the reporter gives another email address
(no mailed letters; a report never publishes without a delivered notice). A daily job after 6 AM
Pacific publishes reports whose 10 days have passed. Reported parties are linked to their own accounts automatically
(same notice email, DOB + last name + mobile, EIN, or company domain) or by the admin, and see their reports and evidence on
the dashboard. Design decisions: `docs/reporting-design.md`.

## Search (phase two, step 3)

Companies with full access search at `/search`.
- **People:** first and last name, date of birth, and an email and/or mobile (home ZIP optional). A match needs the DOB and
  last name plus a matching email or mobile; results show which details matched and flag a different first name or ZIP.
- **Vendors:** website domain or name.
- **Businesses:** EIN, exact legal name + state of registration (case, punctuation and LLC / Inc ignored), or both;
  reports found either way are shown with what they matched on. Results
  show defaults, other reports, and how many other companies searched that business in the last 30 days (counts only,
  never who). Business searches store one-way keys of the EIN and name + state (`fx_searches.subject_keys`), never the EIN.

Each search records a permissible purpose and a certification; employment screening also requires the employment
certification and an uploaded signed authorization. Results show published reports only, with evidence (signed, logged),
and stay viewable for 7 days. Every search is logged in `fx_searches` without DOB, EIN, mobile or ZIP values; reported
parties see "Who has viewed your record", and admin has a Search log. Limit: 60 searches per hour per company.

## Merchant API

- `POST /api/v1/merchant` with `Authorization: Bearer fdx_...` and JSON with what the lender has: `"ein"`,
  `"name"` + `"state"`, or all three (matched on each; every report carries `matched_on`), plus optional
  `"checks": ["default", "document_tampering"]` (both when omitted). Portal business search works the same way. Each check returns `on_record` and, per published report, the incident date, publish date and reporting
  company. Descriptions and evidence stay in the portal: `results_url` opens the full results, showing only the
  checks requested. Also returns searches by other companies in the last 30 days (counts only).
- "document_tampering" is the `fraud` report category internally.
- Access: a company (approved, member terms accepted) requests it at `/api-access` (linked from the dashboard); the admin
  is emailed and approves or denies at `/admin/api`; the company is emailed the decision (`fx_api_access`).
  Once approved, the company creates and revokes its own keys at `/api-access` (up to 5 active). A key is shown once,
  to the company only; FinDex stores an HMAC and a 10-character prefix (`fx_api_keys`). Turning access off in admin
  revokes every key. A key also stops working if the company's FinDex access is revoked.
- Each lookup is logged in `fx_searches` with `api_key_id`, `criteria.via = 'api'` and `criteria.checks`, never the EIN.
  300 lookups per key per hour; 30 failed-key attempts per IP per 15 minutes.
- Documentation: joinfindex.com/api/ (marketing site); the portal's `/api` redirects there.

## AI evidence review

When a report is submitted (and on demand from the admin report page), Claude (`claude-opus-5-5`) reads the evidence
files and writes a structured summary: what each file shows, five checks (matches the party, supports the incident,
dates consistent, required documents present, evidence quality) answered yes / no / unclear with citations, concerns,
and anything missing. It never accepts, rejects or publishes. Only the last 4 digits of an EIN are sent. Results
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

## Tests

`npm test` runs the end-to-end tests in `test/` against an in-memory stand-in for Supabase (database and storage),
with Postmark emails captured instead of sent. No network or credentials needed.

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
| `ONBOARDING_NOTIFY_EMAIL` | Admin email. Receives only: new access requests, new reports, new disputes, and customer changes to a report or dispute (dispute response, report removed, new notice email) |
| `JWT_SECRET` | Long random string |
| `ADMIN_OWNER_EMAIL` | The first admin's email: can always sign in to `/admin` with an emailed code |
| `FIELD_ENCRYPTION_KEY`, `FIELD_HASH_KEY` | Two different long random values (Render's **Generate** button works, or a base64 32-byte key). Keep a copy somewhere safe and never change them once data exists: stored DOB / EIN and the matching keys can't be read without them. |
| `ANTHROPIC_API_KEY` | Optional. Turns on the Claude evidence review in admin (an aid; admins still decide) |
| `POSTMARK_WEBHOOK_TOKEN` | Long random value. Postmark's Bounce webhook calls `https://app.joinfindex.com/webhooks/postmark?token=<value>` |
| `TEST_NOTIFICATIONS` | Optional. `[TEST]` requests email the admin like real ones; set `false` to keep them silent |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Optional |
