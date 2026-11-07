/**
 * Member terms accepted at company sign-up. Each acceptance stores MEMBER_TERMS_VERSION and a timestamp.
 * Bump the version whenever the text changes.
 *
 * DRAFT wording pending legal review: replace with counsel's text before launch.
 */
const MEMBER_TERMS_VERSION = '2026-11-07-draft';

const MEMBER_TERMS = [
  {
    heading: 'Accuracy of submissions',
    text: 'The company is responsible for the accuracy of every report, payment record, and document it submits to FinDex, and will submit only information it believes to be true and supported by evidence.',
  },
  {
    heading: 'Indemnification',
    text: 'The company will defend, indemnify, and hold harmless FinDex and Aquamark from any claims, lawsuits, damages, and legal fees arising from false, inaccurate, or manipulated information the company submits, including false payment data about a funded business.',
  },
];

module.exports = { MEMBER_TERMS_VERSION, MEMBER_TERMS };
