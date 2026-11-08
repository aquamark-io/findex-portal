-- Structured repayment intake: the amount and the status the reporter's system shows (missed payments, defaults).
alter table public.fx_reports add column payment_amount numeric(14,2) check (payment_amount is null or payment_amount > 0);
alter table public.fx_reports add column payment_status text check (payment_status is null or char_length(payment_status) between 2 and 120);
