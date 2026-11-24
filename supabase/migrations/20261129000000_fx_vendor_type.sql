-- "Partners" are now "vendors". Each reported vendor has a type, picked on the report form.
-- Only set for vendors (subject_type 'company'); empty for individuals and funded businesses.
alter table public.fx_subjects add column if not exists vendor_type text;
alter table public.fx_subjects add constraint fx_subjects_vendor_type_check check (
  vendor_type is null or (subject_type = 'company' and vendor_type in (
    'crm_los', 'underwriting', 'document_fraud', 'lead_data', 'marketplace', 'payments_servicing',
    'outsourced_ops', 'it_security', 'legal_compliance', 'broker_partner', 'lender_partner', 'other'
  ))
);
