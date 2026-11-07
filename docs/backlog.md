# Backlog

Ideas and follow-ups to come back to. Newest first.

- **Reporting API for bulk and retroactive reporting.** Let members (especially funders with years of repayment
  history) submit many reports at once instead of one by one. Notes for the design:
  - Per-company API keys created in the member dashboard (shown once, stored hashed, revocable), only for
    companies with full access.
  - Same rules as the web form: one subject email per report, category limits (repayment = funders only),
    7-year window, evidence files required (defaults need the default notice), every report still goes through
    admin review and the 10-day notice. Bulk must not skip review.
  - A **CSV/spreadsheet upload** in the dashboard is a simpler first step for the same goal, and most members
    can use it without a developer. The API can reuse the same validation.
  - Rate limits and a per-batch summary (accepted, rejected and why).
