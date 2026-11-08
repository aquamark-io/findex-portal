# Backlog

Ideas and follow-ups to come back to. Newest first.

- **Payment delinquency: off for launch (defaults only).** Built and switched off in `lib/reports.js` (`off: true`).
  Before turning it back on: repeat-offender tooling (per-reporter rejected/removed counts), dispute "amend" that can
  edit delinquency fields, block re-dating a caught-up report, and an email to the merchant when marked caught up.
- **Repayment API: deferred.** Missed payments became "Payment delinquency" (one report per episode, once the
  merchant has missed one or more payments, at the reporter's discretion, with a delinquent / caught-up status the reporter keeps current), so volume is a few
  reports a month and the web form is enough. Defaults stay in the portal (formal notice + proof of delivery).
  If revisited: per-company API keys, delinquency reports and status updates only, same rules and review as the form.
- **Structured repayment intake: done.** Payment frequency, number of missed payments, past-due amount, first missed payment date.