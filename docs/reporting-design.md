# Search & Reporting: Design Decisions

Status: decisions for the next phase (search, report submission, notices, disputes). Not built yet.
Items marked **Counsel** need legal review before launch. This document is not legal advice.

## Who can do what

| Account | Search | Report | View own record | Dispute / appeal |
|---|---|---|---|---|
| Company (member) | Yes, with a permissible purpose | Yes (incidents) | Yes (own company) | Yes |
| Company: funder | As above | Also funded-business repayment issues (slow pay, defaults) | Yes | Yes |
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
8. **Expired**: deleted automatically after 7 years

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
- To add later: acceptance of the two CFPB member notices above.

## Upgrading a Check My Record company to full access

- **Built:** a company that signed up through Check My Record (own record only) gets a
  **Get full access** button on its dashboard. It shows the two Request Access company checkboxes (authorized +
  indemnification). Accepting records the terms version and time, gives full access **immediately** (the company
  was already verified at approval), emails the admin, and logs it in the account history.
- Individuals and funded businesses can't upgrade; their company signs up through Request Access instead.

## Funded-business reports

- Repayment reports (slow pay, defaults) are about the **business only**, identified by its EIN.
- FinDex does not ask for or store information about owners or personal guarantors in these reports, even when
  the funding included a personal guarantee.
- **Counsel / open:** how to handle sole proprietors with no EIN.

## FCRA scope

- FCRA protects individuals ("consumers"). Reports about businesses (partners, funded businesses) generally fall
  outside it. FinDex applies the same notice and dispute process to everyone anyway.
- **Counsel:** whether sole proprietors, or funded businesses whose funding was personally guaranteed, change this.
  Keeping repayment reports to business-only information is meant to reduce that risk.
