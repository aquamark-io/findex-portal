-- Delinquency status is shown "as of" the date it was reported or last updated, so an un-updated report stays accurate.
alter table public.fx_reports add column delinquency_as_of date;
update public.fx_reports set delinquency_as_of = created_at::date where delinquency_status is not null and delinquency_as_of is null;
