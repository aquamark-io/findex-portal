-- Split impersonation out of fraud: fraud becomes "Document fraud", impersonation is its own category.
alter table public.fx_reports drop constraint fx_reports_category_check;
alter table public.fx_reports add constraint fx_reports_category_check check (category in (
  'data_theft', 'merchant_deception', 'fraud', 'impersonation', 'data_mishandling', 'missed_payments', 'default'
));
