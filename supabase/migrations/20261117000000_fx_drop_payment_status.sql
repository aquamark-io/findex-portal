-- Repayment reports no longer ask for the status in the reporter's system: the screenshot of the missed payment shows it.
alter table public.fx_reports drop column if exists payment_status;
