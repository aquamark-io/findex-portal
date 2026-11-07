-- FinDex phase two, step 1: reported parties (subjects), reports, and evidence files.
-- Same access model as phase one: RLS on, no policies, no grants to anon/authenticated.
-- Sensitive identifiers (*_enc) are AES-256-GCM ciphertext written by the app; identity_hash is the
-- same HMAC "blind index" used on fx_accounts, so a subject can be matched to an account without decrypting.

-- ---------------------------------------------------------------------------
-- fx_subjects: the person or business a report is about. One row per identity, reused across reports.
-- ---------------------------------------------------------------------------
create table public.fx_subjects (
  id                 uuid primary key default gen_random_uuid(),
  subject_type       text not null check (subject_type in ('individual', 'company', 'merchant')),
  name               text not null,              -- individual: full name; company: name as known (DBA ok); merchant: legal name
  dba                text,                       -- merchant DBA, if given
  website            text,                       -- company: normalized origin
  domain             text,                       -- company: website domain, used for matching and search
  contact_name       text,                       -- company / merchant contact person
  dob_enc            text,                       -- individual
  ssn_last4_enc      text,                       -- individual
  ein_enc            text,                       -- merchant
  identity_hash      text,                       -- individual: person:<dob>:<ssn4>; merchant: ein:<ein>
  name_search        text generated always as (lower(name)) stored,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint fx_subjects_individual check (
    subject_type <> 'individual' or (dob_enc is not null and ssn_last4_enc is not null and identity_hash is not null)
  ),
  constraint fx_subjects_company check (
    subject_type <> 'company' or (website is not null and domain is not null and contact_name is not null)
  ),
  constraint fx_subjects_merchant check (
    subject_type <> 'merchant' or (ein_enc is not null and identity_hash is not null and contact_name is not null)
  )
);

-- One subject per identity: individuals and merchants by identity_hash, companies by domain.
create unique index fx_subjects_identity_uq on public.fx_subjects (subject_type, identity_hash) where identity_hash is not null;
create unique index fx_subjects_company_domain_uq on public.fx_subjects (domain) where subject_type = 'company';
create index fx_subjects_name_idx on public.fx_subjects (subject_type, name_search);

create trigger fx_subjects_touch before update on public.fx_subjects
  for each row execute function public.fx_touch_updated_at();

-- Every email a reporter has given for a subject (notices go to the one on the report; search can match any).
create table public.fx_subject_emails (
  subject_id  uuid not null references public.fx_subjects (id) on delete cascade,
  email       text not null check (email = lower(email)),
  created_at  timestamptz not null default now(),
  primary key (subject_id, email)
);
create index fx_subject_emails_email_idx on public.fx_subject_emails (email);

-- ---------------------------------------------------------------------------
-- fx_reports: one incident reported by a member company about a subject.
-- ---------------------------------------------------------------------------
create table public.fx_reports (
  id                    uuid primary key default gen_random_uuid(),
  reporter_account_id   uuid not null references public.fx_accounts (id) on delete restrict,
  subject_id            uuid not null references public.fx_subjects (id) on delete restrict,

  category              text not null check (category in (
                          'data_theft',          -- backdooring and other data theft (individuals, partners)
                          'merchant_deception',  -- individuals
                          'fraud',               -- individuals, partners, funded businesses
                          'data_mishandling',    -- partners
                          'slow_pay',            -- funded businesses, funders only
                          'missed_payments',     -- funded businesses, funders only
                          'default'              -- funded businesses, funders only; default notice required
                        )),
  incident_date         date not null check (incident_date <= current_date),
  description           text not null check (char_length(description) between 20 and 5000),
  notice_email          text not null check (notice_email = lower(notice_email)),
  subject_name_reported text not null,           -- the name exactly as this reporter entered it

  status                text not null default 'submitted' check (status in (
                          'submitted',             -- waiting for admin review
                          'rejected',              -- admin rejected (reporter told why)
                          'notice_sent',           -- accepted; 10-day notice window running (step 2)
                          'notice_undeliverable',  -- notice email bounced; waiting on reporter (step 2)
                          'published',             -- visible in search (step 2)
                          'disputed',              -- withheld during reinvestigation (step 4)
                          'removed',               -- taken down after review or dispute
                          'expired'                -- past 7 years (step 5)
                        )),
  rejection_reason      text,                     -- shared with the reporter
  review_note           text,                     -- internal only
  reviewed_at           timestamptz,
  notice_sent_at        timestamptz,
  publish_at            timestamptz,              -- notice_sent_at + 10 days
  published_at          timestamptz,
  removed_at            timestamptz,
  expires_on            date generated always as ((incident_date + interval '7 years')::date) stored,

  certified_at          timestamptz not null,     -- reporter certified accuracy at submission
  terms_version         text not null,            -- reporter's accepted terms version at submission
  is_test               boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint fx_reports_rejection check (status <> 'rejected' or rejection_reason is not null)
);

create index fx_reports_status_idx on public.fx_reports (status, created_at desc);
create index fx_reports_subject_idx on public.fx_reports (subject_id);
create index fx_reports_reporter_idx on public.fx_reports (reporter_account_id, created_at desc);
create index fx_reports_publish_at_idx on public.fx_reports (publish_at) where status = 'notice_sent';
create index fx_reports_expires_idx on public.fx_reports (expires_on);

create trigger fx_reports_touch before update on public.fx_reports
  for each row execute function public.fx_touch_updated_at();

-- ---------------------------------------------------------------------------
-- fx_report_evidence: files attached to a report, stored in the private fx-evidence bucket.
-- ---------------------------------------------------------------------------
create table public.fx_report_evidence (
  id            uuid primary key default gen_random_uuid(),
  report_id     uuid not null references public.fx_reports (id) on delete cascade,
  kind          text not null default 'evidence' check (kind in ('evidence', 'default_notice')),
  storage_path  text not null unique,             -- <report_id>/<file id>/<safe file name>
  file_name     text not null,
  mime_type     text not null,
  size_bytes    integer not null check (size_bytes > 0),
  sha256        text not null,                    -- integrity fingerprint of the uploaded file
  created_at    timestamptz not null default now()
);
create index fx_report_evidence_report_idx on public.fx_report_evidence (report_id);

-- fx_events can now point at a report as well as an account.
alter table public.fx_events add column report_id uuid references public.fx_reports (id) on delete set null;
create index fx_events_report_idx on public.fx_events (report_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Lock down tables.
-- ---------------------------------------------------------------------------
alter table public.fx_subjects        enable row level security;
alter table public.fx_subject_emails  enable row level security;
alter table public.fx_reports         enable row level security;
alter table public.fx_report_evidence enable row level security;

revoke all on public.fx_subjects, public.fx_subject_emails, public.fx_reports, public.fx_report_evidence
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Private storage bucket for evidence. No storage policies: only the service role (the portal) can read or
-- write; people view files through short-lived signed links the portal creates.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'fx-evidence', 'fx-evidence', false, 26214400,  -- 25 MB per file
  array[
    'application/pdf', 'image/png', 'image/jpeg', 'image/heic', 'image/webp',
    'message/rfc822', 'application/vnd.ms-outlook',                     -- exported emails (.eml, .msg)
    'text/csv', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', -- .xlsx
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', -- .docx
    'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav'                -- lawfully recorded calls
  ]
);
