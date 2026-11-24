-- 1. FinDex no longer collects any part of a Social Security number.
--    People are matched on date of birth + last name + email or mobile (identity_hash = person:v2:<dob>:<last name>,
--    shared by everyone with that DOB and last name, so it is no longer unique).
--    Businesses must have an EIN (the "no EIN, owner's DOB + SSN" option is gone).
-- 2. Businesses can be searched by EIN, or by legal name + state of registration.
-- 3. Each business search keeps one-way keys (HMAC) of the EIN and of name + state, so FinDex can show how many
--    companies searched a business in the last 30 days without storing the EIN.

-- Accounts --------------------------------------------------------------------------------------------------
alter table public.fx_accounts drop constraint if exists fx_accounts_identity;
alter table public.fx_accounts drop constraint if exists fx_accounts_identity_method_check;
-- Existing (pre-launch) DOB + SSN accounts keep their DOB; their old identity key used the SSN, so it is cleared
-- and rebuilt by the app the next time they sign up or are linked.
update public.fx_accounts set identity_method = 'dob', identity_hash = null where identity_method = 'dob_ssn4';
alter table public.fx_accounts drop column if exists ssn_last4_enc;
alter table public.fx_accounts add constraint fx_accounts_identity_method_check check (identity_method in ('dob', 'ein'));
alter table public.fx_accounts add constraint fx_accounts_identity check (
  (identity_method is null)
  or (identity_method = 'ein' and ein_enc is not null)
  or (identity_method = 'dob' and dob_enc is not null)
);

-- Reported parties --------------------------------------------------------------------------------------------
alter table public.fx_subjects drop constraint if exists fx_subjects_individual;
drop index if exists public.fx_subjects_identity_uq;
alter table public.fx_subjects drop column if exists ssn_last4_enc;
alter table public.fx_subjects
  add column if not exists zip5      text check (zip5 ~ '^\d{5}$'),       -- individual, optional
  add column if not exists state     text check (state ~ '^[A-Z]{2}$'),   -- merchant: state of registration
  add column if not exists biz_key   text;                                -- merchant: HMAC of state + normalized legal name
alter table public.fx_subjects add constraint fx_subjects_individual check (
  subject_type <> 'individual' or (dob_enc is not null and identity_hash is not null)
);
-- One subject per EIN; people share DOB + last name keys, so they are told apart by email / mobile instead.
create unique index fx_subjects_merchant_identity_uq on public.fx_subjects (identity_hash) where subject_type = 'merchant';
create index if not exists fx_subjects_identity_idx on public.fx_subjects (subject_type, identity_hash) where identity_hash is not null;
create index if not exists fx_subjects_biz_key_idx on public.fx_subjects (biz_key) where biz_key is not null;

-- Mobile numbers on file for a reported person (like fx_subject_emails), E.164.
create table if not exists public.fx_subject_phones (
  subject_id  uuid not null references public.fx_subjects (id) on delete cascade,
  phone       text not null check (phone ~ '^\+\d{8,15}$'),
  created_at  timestamptz not null default now(),
  primary key (subject_id, phone)
);
alter table public.fx_subject_phones enable row level security;

-- Searches ----------------------------------------------------------------------------------------------------
-- One-way keys for the business searched (EIN key and/or name + state key). Never the EIN itself.
alter table public.fx_searches add column if not exists subject_keys text[] not null default '{}';
create index if not exists fx_searches_subject_keys_idx on public.fx_searches using gin (subject_keys);
create index if not exists fx_searches_created_idx on public.fx_searches (created_at desc);
