-- No minimum length on descriptions or dispute reasons. Description is optional for repayment reports
-- (missed payments, defaults), which have structured amount and status fields.
alter table public.fx_reports alter column description drop not null;
alter table public.fx_reports drop constraint if exists fx_reports_description_check;
alter table public.fx_reports add constraint fx_reports_description_check check (description is null or char_length(description) between 1 and 5000);
alter table public.fx_disputes drop constraint if exists fx_disputes_reason_check;
alter table public.fx_disputes add constraint fx_disputes_reason_check check (char_length(reason) between 1 and 5000);
