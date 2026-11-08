-- FinDex phase two, step 3: search log and employment authorizations.
-- Same access model: RLS on, no policies, no grants to anon/authenticated.

-- ---------------------------------------------------------------------------
-- fx_authorizations: signed disclosure & authorization forms uploaded for employment searches.
-- Files live in the private fx-evidence bucket under authorizations/.
-- ---------------------------------------------------------------------------
create table public.fx_authorizations (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.fx_accounts (id) on delete restrict,
  storage_path  text not null unique,
  file_name     text not null,
  mime_type     text not null,
  size_bytes    integer not null check (size_bytes > 0),
  sha256        text not null,
  created_at    timestamptz not null default now()
);
create index fx_authorizations_account_idx on public.fx_authorizations (account_id, created_at desc);

-- ---------------------------------------------------------------------------
-- fx_searches: every search, with its permissible purpose and what it returned.
-- criteria never holds DOB, SSN or EIN values, only whether they were used.
-- ---------------------------------------------------------------------------
create table public.fx_searches (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.fx_accounts (id) on delete restrict,
  subject_type        text not null check (subject_type in ('individual', 'company', 'merchant')),
  purpose             text not null check (purpose in ('underwriting', 'employment', 'partner_diligence')),
  criteria            jsonb not null default '{}'::jsonb,
  matched_subject_ids uuid[] not null default '{}',
  result_report_ids   uuid[] not null default '{}',
  authorization_id    uuid references public.fx_authorizations (id) on delete restrict,
  certified_at        timestamptz not null,
  ip                  text,
  created_at          timestamptz not null default now(),
  constraint fx_searches_employment check (purpose <> 'employment' or authorization_id is not null)
);
create index fx_searches_account_idx on public.fx_searches (account_id, created_at desc);
create index fx_searches_subjects_idx on public.fx_searches using gin (matched_subject_ids);
create index fx_searches_created_idx on public.fx_searches (created_at desc);

alter table public.fx_authorizations enable row level security;
alter table public.fx_searches       enable row level security;
revoke all on public.fx_authorizations, public.fx_searches from anon, authenticated;
