-- Final report categories (labels live in lib/reports.js). Adds five categories:
--   accidental_data_exposure, no_state_license, no_state_registration, unauthorized_fees, regulatory_violation.
-- Earlier keys stay allowed so any older row keeps a valid category; data_mishandling and missed_payments
-- can no longer be chosen in the portal. No rows are changed.
alter table public.fx_reports drop constraint fx_reports_category_check;
alter table public.fx_reports add constraint fx_reports_category_check check (category in (
  'accidental_data_exposure', 'data_theft', 'default', 'fraud', 'merchant_deception', 'impersonation',
  'no_state_license', 'no_state_registration', 'unauthorized_fees', 'regulatory_violation',
  'data_mishandling', 'missed_payments'
));
