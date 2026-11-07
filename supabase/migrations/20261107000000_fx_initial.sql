-- FinDex portal: accounts, login codes, audit events.
-- Access model: RLS on, no policies, no grants to anon/authenticated.
-- The portal server (service role) is the only access path.


-- ---------------------------------------------------------------------------
-- fx_accounts: one row per access request / account
-- ---------------------------------------------------------------------------
create table public.fx_accounts (
  id                     uuid primary key default gen_random_uuid(),
  account_type           text not null check (account_type in ('company', 'individual', 'merchant')),
  status                 text not null default 'pending' check (status in ('pending', 'approved', 'denied')),

  -- contact (all types)
  email                  text not null check (email = lower(email)),
  first_name             text not null,
  last_name              text not null,
  phone                  text not null,
  job_title              text,

  -- business (company + merchant)
  business_legal_name    text,
  business_dba           text,
  company_type           text check (company_type in ('broker', 'funder', 'lender', 'software_provider', 'lead_provider')),
  website                text,          -- normalized origin, e.g. https://acme.com
  email_domain           text,          -- company accounts: verified to match website domain
  state_of_registration  text,          -- 2-letter code

  -- individual
  current_company        text,
  worker_type            text check (worker_type in ('employee', 'contractor')),

  -- identity (sensitive). *_enc = AES-256-GCM ciphertext "v1:<iv>:<tag>:<data>" (base64).
  -- identity_hash = HMAC-SHA256 blind index for later matching. Never logged or emailed.
  identity_method        text check (identity_method in ('dob_ssn4', 'ein')),
  dob_enc                text,
  ssn_last4_enc          text,
  ein_enc                text,
  identity_hash          text,

  -- review
  is_test                boolean not null default false,
  review_note            text,
  reviewed_at            timestamptz,
  last_login_at          timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint fx_accounts_company_fields check (
    account_type <> 'company'
    or (business_legal_name is not null and company_type is not null and website is not null
        and email_domain is not null and state_of_registration is not null and job_title is not null)
  ),
  constraint fx_accounts_merchant_fields check (
    account_type <> 'merchant'
    or (business_legal_name is not null and state_of_registration is not null)
  ),
  constraint fx_accounts_identity check (
    (identity_method is null)
    or (identity_method = 'ein' and ein_enc is not null)
    or (identity_method = 'dob_ssn4' and dob_enc is not null and ssn_last4_enc is not null)
  ),
  constraint fx_accounts_identity_required check (
    account_type = 'company' or identity_method is not null
  )
);

-- One live (pending/approved) account per email; denied applicants may re-apply.
create unique index fx_accounts_email_live_uq
  on public.fx_accounts (email) where status in ('pending', 'approved');

-- One live company account per domain.
create unique index fx_accounts_company_domain_live_uq
  on public.fx_accounts (email_domain) where account_type = 'company' and status in ('pending', 'approved');

create index fx_accounts_status_created_idx on public.fx_accounts (status, created_at desc);
create index fx_accounts_identity_hash_idx on public.fx_accounts (identity_hash) where identity_hash is not null;

create or replace function public.fx_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger fx_accounts_touch before update on public.fx_accounts
  for each row execute function public.fx_touch_updated_at();

-- ---------------------------------------------------------------------------
-- fx_login_codes: one-time sign-in codes (stored as HMAC, never plaintext)
-- ---------------------------------------------------------------------------
create table public.fx_login_codes (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references public.fx_accounts (id) on delete cascade,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  used_at     timestamptz,
  ip          text,
  created_at  timestamptz not null default now()
);

create index fx_login_codes_account_created_idx on public.fx_login_codes (account_id, created_at desc);
create index fx_login_codes_expires_idx on public.fx_login_codes (expires_at);

-- ---------------------------------------------------------------------------
-- fx_events: audit log. detail must never contain DOB / SSN / EIN.
-- ---------------------------------------------------------------------------
create table public.fx_events (
  id          bigint generated always as identity primary key,
  account_id  uuid references public.fx_accounts (id) on delete set null,
  event       text not null,   -- requested, duplicate_request, approved, denied, code_sent, login, login_failed, logout
  actor       text not null check (actor in ('applicant', 'account', 'admin', 'system')),
  detail      jsonb not null default '{}'::jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);

create index fx_events_account_created_idx on public.fx_events (account_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Lock down: RLS on with no policies; strip API-role grants.
-- ---------------------------------------------------------------------------
alter table public.fx_accounts    enable row level security;
alter table public.fx_login_codes enable row level security;
alter table public.fx_events      enable row level security;

revoke all on public.fx_accounts, public.fx_login_codes, public.fx_events from anon, authenticated;
revoke all on function public.fx_touch_updated_at() from public, anon, authenticated;
