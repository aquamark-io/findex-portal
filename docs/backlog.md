# Backlog

Ideas and follow-ups to come back to. Newest first.

- **Repayment API (current events only).** Let funders and lenders send missed payments and defaults straight
  from their systems as they happen. Decided:
  - Repayment categories only (missed payments, default), funders and lenders only.
  - Current events only: same 90-day window as the web form. No historical backfill, no CSV or bulk upload.
  - Per-company API keys created in the member dashboard (shown once, stored hashed, revocable), only for
    companies with full access.
  - Same rules as the web form: one subject email per report, evidence required (defaults need the default
    notice), every report still goes through admin review and the 10-day notice.
  - Rate limits and a per-request result (accepted, rejected and why).
- **Structured repayment intake.** Missed-payment and default reports collect fields (payment amount, scheduled
  date, missed or returned, return code) instead of only free text, so the API and web form share one shape.
