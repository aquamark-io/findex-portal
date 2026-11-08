-- Payment delinquency (was "missed payments"): one report per delinquency episode, not per payment.
alter table public.fx_reports add column payment_frequency text check (payment_frequency is null or payment_frequency in ('daily', 'weekly', 'monthly'));
alter table public.fx_reports add column missed_count integer check (missed_count is null or missed_count between 1 and 1000);
alter table public.fx_reports add column delinquency_status text check (delinquency_status is null or delinquency_status in ('delinquent', 'caught_up'));
alter table public.fx_reports add column caught_up_on date;
