-- Companies that sign up through Check My Record (to see their own record only) don't accept the
-- Member Terms. Companies signing up through Request Access still must; that's enforced in the app,
-- and terms_version / terms_accepted_at stay set together.
alter table public.fx_accounts drop constraint fx_accounts_company_terms;

alter table public.fx_accounts
  add constraint fx_accounts_terms_pair check ((terms_version is null) = (terms_accepted_at is null));
