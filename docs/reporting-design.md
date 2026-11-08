# Search & Reporting: Design Decisions

> **Status (Nov 8, 2026):** this is a design record. Several ideas here were later dropped or changed:
> slow pay and "missed payments" are replaced by **Payment delinquency** (one or more missed payments, one report per
> delinquency, at the reporter's discretion, within 90 days, optional dated status updates); **no CSV or bulk import**;
> **no mailed letters** (email notices only); **no repayment API yet** (available on request). Categories are now
> data theft or backdooring, deception, document fraud, impersonation, data mishandling, payment delinquency and
> default. `lib/reports.js` is the source of truth for categories, requirements and guidance.


Status: decisions for the next phase (search, report submission, notices, disputes). Not built yet.
Items marked **Counsel** need legal review before launch. This document is not legal advice.

## Phase two decisions (answers to the open questions)

- **Searchers see everything** on a published report: date, category, description, reporting company's name,
  and the evidence files.
- **Redaction:** not automated. Reporters must redact full SSNs and bank account numbers from evidence before
  upload; admin review rejects files that don't. Identifiers FinDex stores (DOB, SSN last 4, EIN) are encrypted
  and masked everywhere they appear, including emails. (Homepage PII card reworded to match.)
- **The reported party sees the evidence** too.
- **Required details when reporting:**
  - Individual: full name, email, **DOB and SSN last 4 (all required)**.
  - Partner company: company name (DBA is fine; legal name often unknown), website, contact person, email.
  - Funded business: legal name, EIN, contact person, email.
- **Searching individuals needs two identifiers** (e.g. name + email, or name + DOB). Never name alone.
- **Timed steps** (publish after 10 days, dispute due dates, 7-year deletion) run **once a day in the morning**.
- **Access logs:** every search is logged (who, when, why); individuals can request the list of who accessed
  their record (FCRA). Promised in the homepage FCRA FAQ.
- Build order as proposed: submission + review → notices + publish + record view → search → disputes →
  retention + CFPB notices.

## Who can do what

| Account | Search | Report | View own record | Dispute / appeal |
|---|---|---|---|---|
| Company (member) | Yes, with a permissible purpose | Yes (incidents) | Yes (own company) | Yes |
| Company: funder or lender | As above | Also funded-business repayment issues (missed payments, defaults) | Yes | Yes |
| Individual | No (own record only) | No | Yes | Yes |
| Funded business | No (own record only) | No | Yes | Yes |

## Searching: permissible purpose

- Every search records a permissible purpose: **employment screening**, **underwriting**, or **partner diligence**.
- **Employment screening of an individual** requires, on every search:
  1. The employer's **certification** (required by FCRA §604(b)): they gave the standalone disclosure, obtained
     written authorization, will follow adverse-action procedures, and won't misuse the report.
  2. An **upload of the signed disclosure and authorization**. Stored and retained like report evidence.
- Employment reports include the CFPB *Summary of Your Rights* for the employer to use in adverse-action notices.
- **Counsel:** whether the FCRA misconduct-investigation exception (§603(y)) changes requirements for current employees.

## Submitting a report

- Required: the subject's identifying details, documented evidence, and **one email address** for the subject.
  No other contact fields at submission.
- FinDex reviews evidence before anything is sent or published.

## Evidence rules (published in the joinfindex.com FAQ)

- Must be documented, verifiable, and sufficient. Attestations, unsupported statements, and hearsay aren't
  accepted on their own.
- Per category: backdooring/data theft (redirecting messages, CRM records, system activity, access logs);
  deceiving merchants (false/misleading communications + documents showing the facts); fraud (copies of the files
  suspected of manipulation + evidence linking it to the reported party; fraud-detection reports as support only);
  partner data mishandling (communications, access logs, system records); repayment (payment history from the
  system of record).
- **Default reports require** a copy of the default notice sent to the merchant. The report form should require
  this upload for the "default" category.
- Original files preferred over screenshots. Call recordings: supporting only, lawfully recorded only
  (**Counsel:** two-party-consent states).
- Submission doesn't guarantee publication. Report form shows the category's examples; admin review has an
  evidence checklist (system of record? more than one item? does the source match?).

## Notice to the reported party

- Applies to **all** subjects: individuals, partners, and funded businesses.
- Sent by email when FinDex accepts the report for publication.
- The notice:
  - discloses the **source** (the reporting company),
  - summarizes what was reported,
  - explains how to create a free account (Check Your Own Record) and dispute or appeal, with a one-time link
    that connects their new account to this report,
  - includes the CFPB *Summary of Your Rights* for individuals.
- **10 calendar days** to respond before the report is published.
- **Bounced email:** the report pauses; the reporting company is asked for an alternative email or a mailing
  address. A mailing address means FinDex sends the notice by post, and the 10 days start from mailing.
  **Counsel:** confirm the start date for mailed notices.

## Report stages (statuses)

1. **Draft**: member is writing it
2. **Submitted**: awaiting FinDex review
3. **Under review**: FinDex checking evidence → may be **Rejected**
4. **Notice sent**: 10-day response window running
5. **Notice undeliverable**: email bounced; waiting on the reporter for another email or mailing address
6. **Disputed**: withheld while FinDex reinvestigates (FCRA: 30 days, up to 45 with new information, for individuals)
   → **Upheld** (published), **Amended**, or **Removed**
7. **Published**: visible in member searches. A later dispute moves it back to *Disputed* and withholds it
8. **Expired**: deleted automatically after 7 years, **unless actively in dispute** (deletion waits until the dispute is resolved)

## Required CFPB forms (Regulation V)

| Form | Recipient | When |
|---|---|---|
| Notice to Users of Consumer Reports | Members | Accepted at sign-up (record version + date); again when the CFPB revises it |
| Notice to Furnishers of Information | Members | Accepted at sign-up (record version + date) |
| A Summary of Your Rights Under the FCRA | Individuals, from FinDex | With every notice and every view of their own record |
| A Summary of Your Rights Under the FCRA | Employers, from FinDex | With each employment-purpose report, for their adverse-action notices |

## Member agreement

- **Built:** Request Access requires an indemnification checkbox; the version and time are stored
  (`terms_version`, `terms_accepted_at`). Text lives in `lib/terms.js`; bump the version whenever it changes.
  Companies that sign up through Check My Record (own record only) don't accept it.
- **One-way indemnification:** the member defends and indemnifies FinDex and Aquamark against claims, damages,
  and legal fees arising from false, inaccurate, or manipulated information it submits, including false payment
  data about a funded business. **Counsel:** replace the draft wording with final text.
- **Built:** acceptance of the CFPB Notice to Users and Notice to Furnishers (linked to the CFPB's Regulation V
  appendices N and M) is a required checkbox on Request Access and Get full access, recorded with the terms version.

## Upgrading a Check My Record company to full access

- **Built:** a company that signed up through Check My Record (own record only) gets a
  **Get full access** button on its dashboard. It shows the two Request Access company checkboxes (authorized +
  indemnification). Accepting records the terms version and time, gives full access **immediately** (the company
  was already verified at approval), emails the admin, and logs it in the account history.
- Individuals and funded businesses can't upgrade; their company signs up through Request Access instead.

## Funded-business reports

- Repayment reports (missed payments, defaults) are about the **business only**, identified by its EIN.
- FinDex does not ask for or store information about owners or personal guarantors in these reports, even when
  the funding included a personal guarantee.
- **Counsel / open:** how to handle sole proprietors with no EIN.

## FCRA scope

- FCRA protects individuals ("consumers"). Reports about businesses (partners, funded businesses) generally fall
  outside it. FinDex applies the same notice and dispute process to everyone anyway.
- **Counsel:** whether sole proprietors, or funded businesses whose funding was personally guaranteed, change this.
  Keeping repayment reports to business-only information is meant to reduce that risk.
