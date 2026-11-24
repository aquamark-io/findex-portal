/**
 * Admin settings, audit log and launch checklist (mounted on /admin after requireAdmin).
 *
 *   GET  /admin/settings                      admins list + add form
 *   POST /admin/settings/admins               add an admin (name, email)
 *   POST /admin/settings/admins/:id/disable   disable (not yourself, not the owner)
 *   POST /admin/settings/admins/:id/enable    re-enable
 *   POST /admin/settings/admins/:id/rename    change the display name
 *   GET  /admin/audit                         audit log, filter by admin, action, date (Pacific)
 *   GET  /admin/launch                        launch checklist
 *   POST /admin/launch/test-email             send a test email to the signed-in admin
 *
 * Admins are disabled, never deleted, so their name stays on past audit entries.
 */
const express = require('express');
const supabase = require('../lib/supabase');
const adminMw = require('../middleware/admin');
const { logAdmin, ACTIONS, TARGET_TYPES } = require('../lib/audit');
const { sendEmail, templates } = require('../lib/email');
const launch = require('../lib/launch');

const router = express.Router();

const normEmail = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const validEmail = v => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(v);
const cleanName = v => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 120) : '');
const msgOf = req => ({ msg: typeof req.query.msg === 'string' ? req.query.msg : null, err: typeof req.query.err === 'string' ? req.query.err : null });
const go = (res, path, text, isErr) => res.redirect(303, `${path}?${new URLSearchParams(isErr ? { err: text } : { msg: text })}`);

// ---------- settings: admins ----------

router.get('/settings', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('fx_admins').select('*').order('created_at', { ascending: true });
    if (error) throw new Error(`Admins: ${error.message}`);
    const admins = (data || []).sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));
    res.render('admin/settings', { pageTitle: 'Admin settings', admins, isOwner: adminMw.isOwner, ownerEmail: adminMw.ownerEmail(),
      passwordEnabled: adminMw.passwordEnabled(), ...msgOf(req) });
  } catch (err) { next(err); }
});

// The shared-password session isn't a person, so it can't manage the admin list.
router.use('/settings/admins', (req, res, next) => {
  if (req.method === 'POST' && req.admin.shared) return go(res, '/admin/settings', 'Sign in with your own emailed code to change the admin list.', true);
  next();
});

router.post('/settings/admins', async (req, res, next) => {
  try {
    const name = cleanName(req.body.name);
    const email = normEmail(req.body.email);
    if (!name) return go(res, '/admin/settings', 'Enter the admin’s name.', true);
    if (!validEmail(email)) return go(res, '/admin/settings', 'Enter a valid email address.', true);
    const { data: existing } = await supabase.from('fx_admins').select('id, status').eq('email', email).maybeSingle();
    if (existing) return go(res, '/admin/settings', existing.status === 'active' ? 'That email is already an admin.' : 'That email is already on the list as disabled. Re-enable it instead.', true);
    const { data: made, error } = await supabase.from('fx_admins').insert({ name, email, added_by: req.admin.id }).select('*').single();
    if (error) throw new Error(`Add admin: ${error.message}`);
    await logAdmin(req, 'admin_added', { targetType: 'admin', targetId: made.id, detail: { name, email } });
    go(res, '/admin/settings', `${name} was added. They can sign in at /admin/login with ${email}.`);
  } catch (err) { next(err); }
});

async function loadAdmin(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data, error } = await supabase.from('fx_admins').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Load admin: ${error.message}`);
  return data;
}

router.post('/settings/admins/:id/:action(disable|enable|rename)', async (req, res, next) => {
  try {
    const target = await loadAdmin(req.params.id);
    if (!target) return go(res, '/admin/settings', 'That admin does not exist.', true);
    const action = req.params.action;
    if (action === 'rename') {
      const name = cleanName(req.body.name);
      if (!name) return go(res, '/admin/settings', 'Enter a name.', true);
      if (name === target.name) return go(res, '/admin/settings', 'No change.');
      await supabase.from('fx_admins').update({ name }).eq('id', target.id);
      await logAdmin(req, 'admin_renamed', { targetType: 'admin', targetId: target.id, detail: { from: target.name, to: name, email: target.email } });
      return go(res, '/admin/settings', `Renamed to ${name}.`);
    }
    if (action === 'disable') {
      if (target.id === req.admin.id) return go(res, '/admin/settings', 'You can’t disable yourself. Ask another admin.', true);
      if (adminMw.isOwner(target)) return go(res, '/admin/settings', 'The owner (ADMIN_OWNER_EMAIL) can’t be disabled from the app.', true);
      if (target.status === 'disabled') return go(res, '/admin/settings', `${target.name} is already disabled.`);
      await supabase.from('fx_admins').update({ status: 'disabled' }).eq('id', target.id);
      await supabase.from('fx_admin_login_codes').delete().eq('admin_id', target.id);
      await logAdmin(req, 'admin_disabled', { targetType: 'admin', targetId: target.id, detail: { name: target.name, email: target.email } });
      return go(res, '/admin/settings', `${target.name} was disabled and signed out.`);
    }
    if (target.status === 'active') return go(res, '/admin/settings', `${target.name} is already active.`);
    await supabase.from('fx_admins').update({ status: 'active' }).eq('id', target.id);
    await logAdmin(req, 'admin_enabled', { targetType: 'admin', targetId: target.id, detail: { name: target.name, email: target.email } });
    return go(res, '/admin/settings', `${target.name} was re-enabled.`);
  } catch (err) { next(err); }
});

// ---------- audit log ----------

const PAGE_SIZE = 100;
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

// Midnight at the start of a Pacific calendar day, as an ISO timestamp.
function pacificMidnight(day) {
  const guess = new Date(`${day}T08:00:00Z`);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'longOffset' })
    .formatToParts(guess).find(p => p.type === 'timeZoneName').value; // "GMT-08:00"
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  const offsetMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : -480;
  return new Date(Date.parse(`${day}T00:00:00Z`) - offsetMin * 60000).toISOString();
}
const nextDay = day => new Date(Date.parse(`${day}T12:00:00Z`) + 24 * 3600 * 1000).toISOString().slice(0, 10);

router.get('/audit', async (req, res, next) => {
  try {
    const f = {
      admin: typeof req.query.admin === 'string' ? req.query.admin : '',
      action: typeof req.query.action === 'string' && ACTIONS[req.query.action] ? req.query.action : '',
      from: isDay(req.query.from) ? req.query.from : '',
      to: isDay(req.query.to) ? req.query.to : '',
    };
    const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
    let q = supabase.from('fx_admin_audit').select('*', { count: 'exact' }).order('created_at', { ascending: false }).order('id', { ascending: false });
    if (f.admin === 'shared') q = q.is('admin_id', null);
    else if (/^[0-9a-f-]{36}$/i.test(f.admin)) q = q.eq('admin_id', f.admin);
    else f.admin = '';
    if (f.action) q = q.eq('action', f.action);
    if (f.from) q = q.gte('created_at', pacificMidnight(f.from));
    if (f.to) q = q.lt('created_at', pacificMidnight(nextDay(f.to)));
    q = q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    const { data: entries, count, error } = await q;
    if (error) throw new Error(`Audit log: ${error.message}`);
    const { data: admins } = await supabase.from('fx_admins').select('id, name, email, status').order('name', { ascending: true });
    const qs = extra => new URLSearchParams(Object.entries({ ...f, ...extra }).filter(([, v]) => v)).toString();
    res.render('admin/audit', { pageTitle: 'Audit log', entries: entries || [], total: count || 0, page, pages: Math.max(1, Math.ceil((count || 0) / PAGE_SIZE)),
      f, admins: admins || [], ACTIONS, TARGET_TYPES, qs });
  } catch (err) { next(err); }
});

// ---------- launch checklist ----------

router.get('/launch', async (req, res, next) => {
  try {
    const checks = await launch.runChecks();
    res.render('admin/launch', { pageTitle: 'Launch checklist', checks, passed: checks.filter(c => c.ok).length, testEmailTo: req.admin.email || process.env.ONBOARDING_NOTIFY_EMAIL || '', ...msgOf(req) });
  } catch (err) { next(err); }
});

router.post('/launch/test-email', async (req, res, next) => {
  try {
    const to = req.admin.email || process.env.ONBOARDING_NOTIFY_EMAIL;
    if (!to) return go(res, '/admin/launch', 'There is no email address to send to.', true);
    let ok = true;
    try { await sendEmail({ to, tag: 'fx-launch-test', ...templates.launchTestEmail() }); } catch (e) { ok = false; console.error('Launch test email failed:', e.message); }
    await logAdmin(req, 'test_email_sent', { detail: { to, sent: ok } });
    go(res, '/admin/launch', ok ? `Test email sent to ${to}. Check that it arrived.` : 'The test email failed to send. Check POSTMARK_SERVER_TOKEN and the sender address in Postmark.', !ok);
  } catch (err) { next(err); }
});

module.exports = router;
