/**
 * Example search results (fictional sample data) so new members can see what a report looks like before
 * FinDex has many published reports. Shown at /search/example/:who with an "Example" banner; nothing here is
 * stored or searchable, and evidence files are not real links.
 */
const day = n => new Date(Date.now() - n * 864e5).toISOString();
const date = n => day(n).slice(0, 10);
const reporter = { business_legal_name: 'Example Funding LLC' };

function example(who) {
  if (who === 'merchant') {
    return {
      search: { id: 'example', subject_type: 'merchant', purpose: 'underwriting', created_at: day(0), expired: false,
        criteria: { name: 'Joe’s Cafe LLC', matched: { s1: { by: ['ein'] } } } },
      reports: [
        { id: 'r1', subject_id: 's1', category: 'default', incident_date: date(45), published_at: day(30), subject_name_reported: 'Joe’s Cafe LLC',
          description: 'Declared in default after 6 missed weekly payments. Default notice sent by certified mail.', reporter },
        { id: 'r2', subject_id: 's1', category: 'fraud', incident_date: date(70), published_at: day(55), subject_name_reported: 'Joe’s Cafe LLC',
          description: 'Bank statements submitted with the application were altered: balances were increased on 3 of 4 pages. The bank confirmed the original figures.', reporter },
      ],
      files: { r1: [{ file_name: 'payment-ledger.pdf', size_bytes: 84000 }, { file_name: 'default-notice.pdf', size_bytes: 52000 }],
        r2: [{ file_name: 'submitted-statement.pdf', size_bytes: 310000 }, { file_name: 'bank-verification.pdf', size_bytes: 96000 }] },
      activity: { searches: 4, companies: 3 },
    };
  }
  if (who === 'vendor') {
    return {
      search: { id: 'example', subject_type: 'company', purpose: 'partner_diligence', created_at: day(0), expired: false,
        criteria: { domain: 'leakycrm.example', matched: {} } },
      reports: [
        { id: 'r1', subject_id: 's1', category: 'accidental_data_exposure', incident_date: date(100), published_at: day(80), subject_name_reported: 'Leaky CRM Inc',
          fx_subjects: { vendor_type: 'crm_los' },
          description: 'Merchant applications stored in the CRM were shared with a third-party lead buyer without our authorization.', reporter },
      ],
      files: { r1: [{ file_name: 'export-log.csv', size_bytes: 12000 }, { file_name: 'lead-buyer-email.pdf', size_bytes: 64000 }] },
      activity: null,
    };
  }
  return {
    search: { id: 'example', subject_type: 'individual', purpose: 'employment', created_at: day(0), expired: false,
      criteria: { name: 'Jordan Rivera', matched: { s1: { dob: true, last_name: true, first_name: true, email: true, phone: false } } } },
    reports: [
      { id: 'r1', subject_id: 's1', category: 'data_theft', incident_date: date(80), published_at: day(60), subject_name_reported: 'Jordan Rivera',
        description: 'Exported our merchant pipeline to a personal email address two days before resigning.', reporter },
    ],
    files: { r1: [{ file_name: 'email-forwarding-log.pdf', size_bytes: 140000 }] },
    activity: null,
  };
}

module.exports = { example, WHO: ['individual', 'vendor', 'merchant'] };
