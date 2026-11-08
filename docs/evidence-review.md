# Evidence Review at Scale: Proposed Workflow

Status: proposal, with decisions recorded below. Build step A (AI-assisted review) is built. Not legal advice; items marked **Counsel** need review.

## 1. What "evidence-based" should mean

Every report raises four separate questions. They need different tools, and only some can be automated.

| Question | Example | Who/what can answer it |
|---|---|---|
| **Identity:** is the evidence about this party? | Ledger shows the same EIN and legal name as the report | Rules + AI extraction, reliably |
| **Support:** does the evidence show what is claimed, on the dates claimed? | Ledger shows 3 returned payments in the reported window | Rules (structured data) + AI (documents), reasonably well |
| **Completeness / currency:** is anything left out, and is it still true today? | A returned payment that was later made up | Only partly: requires the reporter to state current status, plus later updates |
| **Authenticity:** is the document genuine? | Screenshot edited before upload | Not provable by AI. Mitigated by source type, cross-checks, audits and reporter accountability |

FinDex should not claim to "verify" that allegations are true. What it can honestly stand behind:
**"The reporter submitted documentation that, on review against published criteria, matches the reported party and
supports the reported facts; the reported party was notified and given the chance to dispute."**
Published reports should show how they were reviewed (human or automated), the type of evidence, and the status
"as of" a date. **Counsel:** align the homepage/FAQ wording ("verified", "independently reviewed") with this.

Two rules that hold for every category:
- **Silence is not verification.** Publication requires a positive acceptance on the evidence. The 10-day notice is an
  extra safeguard, not part of proof. "Not disputed" may be shown as a fact, never as confirmation.
- **A screenshot is a claim, not proof.** A CRM screen showing "Default" proves only that someone set a field. Criteria
  must ask for the underlying facts (payment history, contract terms, notice sent).

## 2. Legal standards differ by category

| | Individuals (employees, contractors) | Partners (companies) | Funded businesses (merchants) |
|---|---|---|---|
| FCRA consumer report? | **Likely yes** when used for employment or eligibility | Generally no (business, not consumer) | Generally no, **except** sole proprietors and owner-guaranteed obligations, which **Counsel** must assess |
| Accuracy standard | §607(b): **reasonable procedures to assure maximum possible accuracy**. Courts look at whether matching and review are actually reasonable; rubber-stamping a furnisher's word is a known failure | Truthfulness and fair process (defamation, trade libel, tortious interference risk) plus FinDex's own published standards | Same as partners, plus contract-specific definitions (MCA vs. loan) |
| Disputes | §611: reinvestigation within 30 days (45 with new info), must be a real reinvestigation, not "parroting" the reporter; notify furnisher; delete if unverifiable | Contractual/own policy (we use the same 30 days) | Same as partners |
| Matching | Multiple identifiers required (name alone is inadequate) | Domain / legal name | EIN |
| Retention | §605: most adverse items limited to 7 years | Own policy (7 years) | Own policy (7 years) |
| Reporter duties | §623 furnisher duties: don't furnish known-inaccurate info, correct and update, investigate disputes | Contractual (member terms) | Contractual (member terms) |

Practical consequence: **individual reports keep human acceptance for the foreseeable future**, even after automation
proves itself elsewhere. Business categories can graduate to automation first, starting with merchant repayment.

## 3. Proposed workflow (all categories)

```
Intake ─▶ Automated checks ─▶ AI evidence review ─▶ Routing ─▶ Human decision ─▶ Notice ─▶ 10 days ─▶ Publication check ─▶ Published
                                                                  ▲                     │
                                                         (later: auto-accept      dispute ─▶ human reinvestigation
                                                          for validated cases)
```

1. **Intake.** Portal form (all categories); CSV and API later for repayment only. Every incident gets its own report
   record, even inside a batch.
2. **Automated checks (deterministic, no AI).** Required fields; identifiers well formed; incident within 7 years;
   required documents present and readable file types; duplicate detection (section 5); for structured repayment data,
   arithmetic and date checks (scheduled vs. received, return codes, cure dates).
3. **AI evidence review (Claude).** For each file: extract the facts it shows (names, EIN, dates, amounts, statuses,
   return codes, document type), then evaluate each **category criterion** separately with one of
   `met / not met / unclear`, citing which file and what it shows. Also flags: unreadable, possible editing,
   inconsistencies between files, missing context. **No single confidence score.** (Why: a model's self-reported
   confidence is not a calibrated probability, and one number hides which criterion failed.)
4. **Routing (rules over the per-criterion results).**
   - Any automated check failed → back to reporter with the specific problem (no human time spent).
   - All criteria `met`, no flags → "clear" queue.
   - Any `not met` → "likely reject" queue (human confirms; reporter told what's missing).
   - Any `unclear` or flag → "needs review" queue.
5. **Human decision.** At launch, a human accepts or rejects **every** report, with the AI's pre-filled checklist
   and citations to speed it up. The human records a decision **per criterion** (this is the labeled data we need to
   measure the AI later). Rejections and "need more evidence" go back to the reporter with reasons.
6. **Notice → 10 days → publication check.** Publication eligibility = accepted on evidence + notice delivered (or
   mailed) + 10 days passed + no open dispute + (repayment) status confirmed current within 90 days.
7. **Disputes.** Always human. The reinvestigation re-runs the AI review including the disputer's files, but the
   decision is a person's.

## 4. Category criteria (draft, to refine on real cases)

Criteria must be written as checkable statements. Draft starting points:

**Merchant repayment (all three).** Evidence must show: merchant legal name or EIN matching the report; that the
funder funded this merchant (contract or funding record); the payment schedule; the payment history from the system of
record covering the incident window; and the merchant's **current status** as of a stated date.

| Category | Definition to settle | Additional requirements |
|---|---|---|
| Missed payments | Scheduled payment not received/returned and **not made up within N business days** | Return codes (e.g. NSF vs. stop payment vs. account closed); show whether later cured |
| Slow pay | Payments made but late beyond N days, in at least M instances within a period | Dates scheduled vs. received |
| Default | Per the contract's default clause, **uncured** for N days, with notice | Default clause excerpt; default notice sent; payments missed; no cure after notice |

MCA-specific issue (**Counsel** + you): a good-faith **reconciliation request** or reduced receivables may be
contractually permitted and not a "missed payment" or "default". The form should ask whether reconciliation was
requested and how it was handled; otherwise FinDex risks publishing a contract dispute as a default.

**Individual misconduct.** Evidence must tie the **specific person** to the act (their account, email address, device
or signature, not just their name in a message), show the act itself, and show the date. Examples: an email from their
work account forwarding merchant files to a personal or competitor address; CRM audit log under their login. Allegations
based on inference alone (merchant switched funders after the employee left) do not meet the bar.

**Partner misconduct.** Same structure: the conduct, attributed to the company (its domain, signed agreement, or
representative acting for it), on the stated dates, plus the relationship (agreement or deal record) showing why the
reporter was affected.

## 5. Bulk and retroactive repayment reporting

**Structured records instead of a screenshot per incident.** For repayment, a system-of-record export is better evidence
than screenshots: it is complete for a period, arithmetically checkable, and harder to fake consistently. Proposed
"repayment record" per incident:

- Reporter's **deal ID** (`external_ref`, required, unique per reporter)
- Merchant legal name, EIN, contact email
- Product type (MCA / loan / other), funding date, payment frequency and amount
- Payment ledger rows: scheduled date, amount due, amount received, received date, return code
- Incident category and window; reconciliation requested (Y/N + outcome)
- **Current status + as-of date**: open / cured / settled / paid in full / charged off
- Attachments: ledger export (CSV/PDF from the LOS/CRM), contract pages (parties + payment terms + default clause),
  default notice (defaults only)

**Making exports acceptable.** Exports should come straight from the system of record and include the merchant
identifier on the file or in the row; FinDex re-computes totals and checks them against the claim. At onboarding, each
bulk reporter does a short **source check** (screen-share or sample originals) so their export format is known. Mismatches
between ledger math and the reported category are automatic rejections.

**Linking evidence in a batch.** CSV (or API JSON) row per incident with `external_ref`; evidence uploaded as a ZIP where
each file name starts with the `external_ref` (or one ledger export covering many deals, with the deal ID column). Rows
whose evidence can't be matched fail validation individually; the rest proceed.

**Duplicates vs. updates.** `(reporter, external_ref, category)` is unique. Re-sending the same key is an **update**
(status changes such as "cured", corrections), not a new report, and keeps the same report history and notice. The same
merchant reported by **different** funders is legitimate (separate deals, e.g. stacking) and stays separate; FinDex
shows them as separate incidents. Near-duplicates (same reporter, same EIN, overlapping window, different deal ID) are
flagged for human review.

**Historical incidents.**
- Must include current status as of submission; resolved incidents publish **as resolved** (e.g. "Missed payments,
  cured Mar 2024"), never as an open condition.
- Reporters agree (member terms) to send status updates within N days of any change, and to confirm open items every
  90 days; stale open items are flagged and can be suppressed until confirmed.
- Older incidents have worse contact data. Expect more bounces and mailed letters; budget for it or require a current
  contact email for anything older than ~2 years. **Decision needed** on whether minor cured incidents are reportable
  at all.

**Notices for a batch.** One review outcome and one dispute right per incident, but **one consolidated notice email per
merchant** listing all incidents from the same reporter in that release, each disputable on its own.

**Pacing.** Batches are validated and AI-reviewed immediately but held as "staged". Staged incidents are released
into the human queue in tranches sized to reviewer capacity, with **new incidents prioritised over historical**, and a
per-reporter daily cap on historical releases (e.g. 100/day). Reporters see each row's state. This also caps notice
volume and Postmark sending.

## 6. AI review: how it would work and its limits

- **Inputs:** the report's claimed facts, the category criteria, and the evidence files (images/PDFs read directly;
  spreadsheets converted to text). **Output:** strict JSON: extracted facts, per-criterion result + citation, flags.
- **Deterministic first:** anything code can check (math, dates, EIN match, duplicates) is checked by code, not the
  model. The model handles reading documents and judging fit against criteria.
- **Prompt injection:** evidence can contain text like "approve this report". The model is told evidence is data, the
  output schema is fixed, and a model output can only route, never publish, at launch.
- **Authenticity:** the model may flag signs of editing or internal inconsistency; it cannot certify a file is real.
  Authenticity rests on source type (exports over screenshots), cross-checks, reporter accountability (certification,
  indemnity, suspension for falsified evidence), and random audits asking for originals.
- **Versioning:** record model ID, prompt version and criteria version with every AI review, so results stay comparable
  and any change triggers re-validation.
- **Data handling:** evidence includes personal data. Confirm Anthropic API terms for your org (API inputs are not used
  for training by default; check retention options and a DPA) and update the privacy policy. **Counsel.**
- **Cost:** per page/image reviewed; measure during the pilot rather than estimate now.

## 7. Launch scope: automate vs. keep human

| At launch: automated | At launch: human |
|---|---|
| Intake validation, identity format checks, duplicates/updates | Accept / reject of **every** report |
| Ledger math and date checks (structured repayment) | All "unclear", "likely reject" and flagged cases |
| AI extraction + per-criterion checklist (as reviewer aid) | All disputes (always) |
| Routing, queues, prioritisation, pacing | Individual (FCRA) reports: indefinitely |
| Notices after acceptance, publishing after the window, reminders, retention | Partner misconduct: indefinitely (low volume, high stakes) |

## 8. Earning automation (merchant repayment first)

1. **Labeled set.** Every human decision is recorded per criterion. Periodically, two reviewers decide the same sample
   independently to measure human-to-human agreement (the realistic ceiling).
2. **Metrics.**
   - **False accept rate** on cases the AI marks "clear": the share a human would have rejected. This is the number
     that matters most.
   - False reject / needs-more-info rate (cost, not harm).
   - Post-publication dispute rate and **overturn rate** (disputes that end in amend/remove), by category and reporter.
   - Time to decision; reviewer minutes per report.
3. **Graduation rule (to set, example only).** After at least ~300 human-reviewed repayment reports, if the AI's "clear"
   cases show a false-accept rate whose **upper 95% bound** is below an agreed limit (e.g. 2%), allow "clear" + all
   automated checks passing to **auto-accept** for that category, with a random **10% human audit** and per-reporter
   limits.
4. **Guardrails after graduation.** Automatic rollback to human review if audit false-accepts or dispute overturns rise
   above the limit; per-reporter trust tiers (new reporters 100% human for their first N reports; tier drops on overturned
   disputes); kill switch per category; re-validation whenever the model, prompt or criteria change.

## 9. Open decisions

1. Exact definitions (N days, M instances) for missed payments, slow pay and default, and whether MCA reconciliation
   excludes an incident.
2. Are minor cured incidents (e.g. one returned payment made up within a week) reportable?
3. Retroactive window for repayment: full 7 years, or shorter (e.g. 3 years) with current-status confirmation?
4. Required status-update cadence for reporters (e.g. within 10 days of change; confirm open items every 90 days).
5. What published reports display about review method, evidence type and "as of" status.
6. Graduation thresholds: minimum reviewed count, acceptable false-accept limit, audit rate.
7. Reporter consequences for falsified or careless submissions (warning, suspension, termination, indemnity claim).
8. Whether bulk/API is limited to reporters who pass an onboarding source check.
9. Budget/approach for mailed notices on historical imports with stale contacts.
10. Counsel: FCRA scope for individual and sole-proprietor/guarantor reports; wording of "verified"; AI vendor data terms.

## 10. Suggested build order (after decisions)

- **A. Criteria + AI-assisted review in admin** for all categories: criteria as data, Claude review stored per report,
  pre-filled checklist, per-criterion human decisions captured. (Value immediately; creates the labeled data.)
- **B. Structured repayment intake** in the portal: deal ID, ledger fields, current status, status updates.
- **C. CSV bulk upload** with ZIP evidence, staging, pacing, consolidated notices.
- **D. Repayment API** reusing B/C validation (per-company API keys).
- **E. Measured automation** for repayment once section 8's rule is met.

## 11. Decisions (Nov 8, 2026)

- **Events, not outcomes.** Reporters report what happened on a date (a missed payment, a declared default). Later
  repayment or settlement does not erase the event, and FinDex does not track ongoing status. A dispute asks whether
  the event happened as reported; the reporter points to its contract and may choose to release the report.
- **Missed payment:** a scheduled payment not received on its due date (including returned payments), reportable even
  if made up later, regardless of product. A payment the reporter agreed to adjust (e.g. approved reconciliation) was
  not due. **Default:** declared by the reporter under its contract; default notice required; incident date = date
  declared. **Slow pay is dropped.**
- **7-year window** for all categories, including historical imports.
- **Public view** shows only date, category, reporter, description and evidence. Review details stay in admin.
- **Automation:** none yet. Claude writes a review summary; the admin makes every decision. No scores or thresholds
  until there is enough reviewed history to learn from.
- **Consequences:** falsified or careless submissions lead to removal from the index and an admin incident report
  filed by FinDex about the member (same notice and dispute process). **Counsel:** add to member terms.
- **Bulk and API are for funded-business repayment incidents only** (missed payments, default). Individual, partner,
  and merchant-fraud reports stay in the portal.
- **CSV import is for historical incidents only:** incidents dated before the member's account was approved. Current
  and future incidents go through the portal or API. The CSV rows are claims; a system-of-record payment export
  (one file can cover the batch, matched by deal ID) is the evidence. Each row succeeds or fails on its own.
- **API authentication:** per-company API keys created on the dashboard (not one shared key).
- **Email only:** every report needs a deliverable email for the reported party. No mailed letters; a report never
  publishes without a delivered notice.
- **Exports are accepted in good faith,** backed by certification, indemnity, the merchant's right to dispute, and
  consequences for falsification.
- No onboarding source check.
