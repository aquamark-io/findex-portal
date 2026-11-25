/**
 * Sample reports (fictional data) for the Activity page, so new members can see how reports appear and move
 * through review before they have any of their own. Nothing here is stored or searchable.
 */
const day = n => new Date(Date.now() - n * 864e5).toISOString();
const date = n => day(n).slice(0, 10);

const SUBMITTED = [
  { n: 1, created_at: day(2), subject_name_reported: 'Jordan Rivera', fx_subjects: { subject_type: 'individual' }, category: 'data_theft',
    incident_date: date(30), status: 'submitted', notice_email: 'jordan@example.com',
    description: 'Exported our merchant pipeline to a personal email address two days before resigning.',
    files: [{ file_name: 'email-forwarding-log.pdf', size_bytes: 140000 }] },
  { n: 2, created_at: day(9), subject_name_reported: 'Leaky CRM Inc', fx_subjects: { subject_type: 'company', vendor_type: 'crm_los', website: 'https://leakycrm.example', contact_name: 'Sam Vendor' },
    category: 'accidental_data_exposure', incident_date: date(60), status: 'notice_sent', publish_at: day(-3), notice_email: 'sam@leakycrm.example',
    description: 'Merchant applications stored in the CRM were shared with a third-party lead buyer without our authorization.',
    files: [{ file_name: 'export-log.csv', size_bytes: 12000 }, { file_name: 'lead-buyer-email.pdf', size_bytes: 64000 }] },
  { n: 3, created_at: day(40), subject_name_reported: 'Joe’s Cafe LLC', fx_subjects: { subject_type: 'merchant', contact_name: 'Joe Smith' },
    category: 'default', incident_date: date(55), status: 'published', published_at: day(28), notice_email: 'joe@joescafe.example',
    description: 'Declared in default after 6 missed weekly payments. Default notice sent by certified mail.',
    files: [{ file_name: 'payment-ledger.pdf', size_bytes: 84000 }, { file_name: 'default-notice.pdf', size_bytes: 52000, kind: 'default_notice' }] },
];

// A report someone else filed about the member's company.
const ABOUT = { n: 4, created_at: day(6), subject_name_reported: 'Your company', category: 'merchant_deception', incident_date: date(20),
  status: 'notice_sent', publish_at: day(-4), reporter: { business_legal_name: 'Example Funding LLC' },
  description: 'A rep told the merchant their rate was lower than the contract stated.', files: [{ file_name: 'call-recording-notes.pdf', size_bytes: 70000 }] };

const SEARCHES = [
  { who: 'individual', name: 'Jordan Rivera', type: 'individual', reports: 1, created_at: day(1) },
  { who: 'vendor', name: 'Leaky CRM Inc', type: 'company', reports: 1, created_at: day(3) },
  { who: 'merchant', name: 'Joe’s Cafe LLC', type: 'merchant', reports: 2, created_at: day(5) },
];

const find = n => SUBMITTED.find(r => r.n === n) || (ABOUT.n === n ? ABOUT : null);

module.exports = { SUBMITTED, ABOUT, SEARCHES, find };
