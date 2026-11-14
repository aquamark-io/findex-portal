# Backlog

Ideas and follow-ups to come back to. Newest first.

- **Payment delinquency: removed (defaults only).** The category, its form fields (payment frequency, missed
  payments, past-due amount), the delinquent / caught-up status updates and their displays were taken out of the code.
  The `fx_reports` columns (`payment_amount`, `payment_frequency`, `missed_count`, `delinquency_status`,
  `caught_up_on`, `delinquency_as_of`) are still in the database, unused. Earlier notes below are history.
- **Repayment API: deferred.** Missed payments became "Payment delinquency" (one report per episode, once the
  merchant has missed one or more payments, at the reporter's discretion, with a delinquent / caught-up status the reporter keeps current), so volume is a few
  reports a month and the web form is enough. Defaults stay in the portal (formal notice + proof of delivery).
  If revisited: per-company API keys, delinquency reports and status updates only, same rules and review as the form.
- **Structured repayment intake: done.** Payment frequency, number of missed payments, past-due amount, first missed payment date.