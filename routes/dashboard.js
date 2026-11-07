// Placeholder dashboards. Search, reporting and disputes come in a later phase.
const express = require('express');
const { requireAccount } = require('../middleware/auth');
const { COMPANY_TYPES } = require('../lib/validate');

const router = express.Router();

router.get('/dashboard', requireAccount, (req, res) => {
  const a = req.account;
  res.render('dashboard', {
    pageTitle: 'Dashboard',
    COMPANY_TYPES,
    // Only funder members may report funded-business repayment issues (slow pay, defaults).
    canReportRepayment: a.account_type === 'company' && a.company_type === 'funder',
  });
});

module.exports = router;
