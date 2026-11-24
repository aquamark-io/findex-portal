/**
 * Admin: contact form messages (mounted on /admin after requireAdmin).
 *
 *   GET  /admin/contact?status=open|in_progress|closed   the queue (open first by default)
 *   GET  /admin/contact/:id                              read the message (recorded in the audit log)
 *   POST /admin/contact/:id                              change status and/or the internal note
 */
const express = require('express');
const supabase = require('../lib/supabase');
const { logAdmin } = require('../lib/audit');
const { TOPICS, STATUSES, referenceOf } = require('../lib/contact');

const router = express.Router();
const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
const msgOf = req => ({ msg: typeof req.query.msg === 'string' ? req.query.msg : null, err: typeof req.query.err === 'string' ? req.query.err : null });

router.use('/contact', (req, res, next) => { Object.assign(res.locals, { TOPICS, STATUSES, referenceOf }); next(); });

router.get('/contact', async (req, res, next) => {
  try {
    const status = Object.hasOwn(STATUSES, req.query.status) ? req.query.status : 'open';
    const { data, error } = await supabase.from('fx_contact_requests')
      .select('id, name, contact_email, topic, status, created_at, closed_at, account_id')
      .eq('status', status).order('created_at', { ascending: status !== 'closed' }).limit(500);
    if (error) throw new Error(`Contact list: ${error.message}`);
    const counts = {};
    await Promise.all(['open', 'in_progress'].map(async s => {
      const { count } = await supabase.from('fx_contact_requests').select('id', { count: 'exact', head: true }).eq('status', s);
      counts[s] = count || 0;
    }));
    res.render('admin/contact-list', { pageTitle: 'Contact messages', rows: data || [], status, counts });
  } catch (err) { next(err); }
});

async function load(id) {
  if (!isUuid(id)) return null;
  const { data, error } = await supabase.from('fx_contact_requests').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Contact message: ${error.message}`);
  return data;
}

router.get('/contact/:id', async (req, res, next) => {
  try {
    const row = await load(req.params.id);
    if (!row) return res.status(404).render('error', { pageTitle: 'Not found', message: 'That message does not exist.' });
    await logAdmin(req, 'contact_opened', { targetType: 'contact', targetId: row.id, detail: { reference: referenceOf(row.id), topic: row.topic } });
    let account = null;
    if (row.account_id) {
      const { data } = await supabase.from('fx_accounts').select('id, first_name, last_name, business_legal_name, status').eq('id', row.account_id).maybeSingle();
      account = data;
    }
    res.render('admin/contact', { pageTitle: referenceOf(row.id), row, account, ...msgOf(req) });
  } catch (err) { next(err); }
});

router.post('/contact/:id', async (req, res, next) => {
  try {
    const row = await load(req.params.id);
    if (!row) return res.redirect(303, '/admin/contact');
    const status = Object.hasOwn(STATUSES, req.body.status) ? req.body.status : row.status;
    const note = typeof req.body.note === 'string' ? (req.body.note.trim().slice(0, 2000) || null) : row.admin_note;
    if (status === row.status && note === row.admin_note) return res.redirect(303, `/admin/contact/${row.id}?msg=No+changes.`);
    const update = { status, admin_note: note };
    if (status !== row.status) update.closed_at = status === 'closed' ? new Date().toISOString() : null;
    const { error } = await supabase.from('fx_contact_requests').update(update).eq('id', row.id);
    if (error) throw new Error(`Update contact message: ${error.message}`);
    await logAdmin(req, 'contact_updated', { targetType: 'contact', targetId: row.id,
      detail: { reference: referenceOf(row.id), ...(status !== row.status ? { from: row.status, to: status } : {}), note_changed: note !== row.admin_note } });
    res.redirect(303, `/admin/contact/${row.id}?${new URLSearchParams({ msg: status !== row.status ? `Marked ${STATUSES[status].toLowerCase()}.` : 'Note saved.' })}`);
  } catch (err) { next(err); }
});

module.exports = router;
