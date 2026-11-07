// Requires a signed-in, still-approved account. Re-checks the database on every request,
// so denying or revoking an account in /admin ends its access immediately.
const supabase = require('../lib/supabase');
const { readSession, clearSession } = require('../lib/session');

async function requireAccount(req, res, next) {
  const session = readSession(req);
  if (!session) return res.redirect('/login');
  try {
    const { data: account, error } = await supabase.from('fx_accounts')
      .select('id, account_type, status, first_name, last_name, email, business_legal_name, company_type')
      .eq('id', session.sub).maybeSingle();
    if (error) throw new Error(error.message);
    if (!account || account.status !== 'approved') {
      clearSession(res);
      return res.redirect('/login');
    }
    req.account = account;
    res.locals.account = account;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAccount };
