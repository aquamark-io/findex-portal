/**
 * Member terms accepted at company sign-up (Request Access). Each acceptance stores
 * MEMBER_TERMS_VERSION and a timestamp. Bump the version whenever the text changes.
 *
 * DRAFT wording pending legal review: replace with counsel's text before launch.
 */
const MEMBER_TERMS_VERSION = '2026-11-08c-draft';

// Shown as a checkbox the company representative must tick.
const INDEMNIFICATION =
  'On behalf of the company, I agree that it will indemnify and hold harmless FinDex from any claims, damages, and legal fees arising from false, inaccurate, or manipulated information it submits.';

// CFPB notices every member receives (Regulation V appendices). Linked, not copied, so they stay current.
const CFPB_NOTICE_TO_USERS_URL = 'https://www.consumerfinance.gov/rules-policy/regulations/1022/n/';
const CFPB_NOTICE_TO_FURNISHERS_URL = 'https://www.consumerfinance.gov/rules-policy/regulations/1022/m/';

module.exports = { MEMBER_TERMS_VERSION, INDEMNIFICATION, CFPB_NOTICE_TO_USERS_URL, CFPB_NOTICE_TO_FURNISHERS_URL };
