-- Member terms (incl. one-way indemnification) accepted at company sign-up.
alter table public.fx_accounts
  add column terms_version     text,
  add column terms_accepted_at timestamptz;

alter table public.fx_accounts
  add constraint fx_accounts_company_terms check (
    account_type <> 'company' or (terms_version is not null and terms_accepted_at is not null)
  );
