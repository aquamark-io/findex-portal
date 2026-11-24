/**
 * In-memory stand-in for the parts of supabase-js FinDex uses, for tests only.
 *   from(): select / insert / update / upsert / delete with eq, neq, is, gt, gte, lt, lte, in, ilike, or, order,
 *           limit, range, single, maybeSingle, count/head; JSON paths in filters ('detail->>day');
 *           embedded resources in select ('fx_subjects(*)', 'reporter:fx_accounts!fk(...)') via RELATIONS below.
 *   storage.from(bucket): upload, download, createSignedUrl, remove.
 * Mirrors the schema's defaults, generated columns and unique indexes (returned as Postgres error 23505).
 * Check constraints and triggers live in the SQL migrations and are not re-implemented here.
 */
const crypto = require('crypto');

const LIVE = r => ['pending', 'approved'].includes(r.status);
// [columns, optional row predicate for partial unique indexes]
const UNIQUE = {
  fx_accounts: [[['email'], LIVE], [['email_domain'], r => r.account_type === 'company' && LIVE(r)]],
  fx_subjects: [[['identity_hash'], r => r.subject_type === 'merchant'], [['domain'], r => r.subject_type === 'company']],
  fx_subject_phones: [[['subject_id', 'phone']]],
  fx_subject_emails: [[['subject_id', 'email']]],
  fx_subject_links: [[['subject_id', 'account_id']]],
  fx_report_evidence: [[['storage_path']]],
  fx_dispute_files: [[['storage_path']]],
  fx_authorizations: [[['storage_path']]],
  fx_notices: [[['postmark_message_id'], r => r.postmark_message_id != null]],
  fx_disputes: [[['report_id'], r => r.status === 'open']],
  fx_api_keys: [[['key_hash']]],
  fx_api_access: [[['account_id']]],
  fx_admins: [[['email']]],
};

const DEFAULTS = {
  fx_accounts: { status: 'pending', is_test: false },
  fx_login_codes: { attempts: 0, used_at: null },
  fx_events: { detail: {} },
  fx_reports: { status: 'submitted', is_test: false },
  fx_report_evidence: { kind: 'evidence' },
  fx_searches: { criteria: {}, matched_subject_ids: [], result_report_ids: [], subject_keys: [], api_key_id: null },
  fx_disputes: { status: 'open' },
  fx_evidence_reviews: { files_reviewed: 0, files_skipped: [] },
  fx_api_keys: { last_used_at: null, revoked_at: null },
  fx_admins: { status: 'active', added_by: null, last_login_at: null },
  fx_admin_login_codes: { attempts: 0, used_at: null },
  fx_admin_audit: { detail: {} },
};
const INT_IDS = new Set(['fx_events', 'fx_admin_audit']);
// Mirrors the fx_admin_audit trigger: rows can't be changed or deleted.
const APPEND_ONLY = new Set(['fx_admin_audit']);
const NO_ID = new Set(['fx_subject_emails', 'fx_subject_phones', 'fx_subject_links', 'fx_api_access']); // composite primary keys

// Generated columns.
function generate(table, row) {
  if (table === 'fx_subjects') row.name_search = row.name == null ? null : String(row.name).toLowerCase();
  if (table === 'fx_reports' && row.incident_date) {
    const d = new Date(`${row.incident_date}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() + 7);
    row.expires_on = d.toISOString().slice(0, 10);
  }
  return row;
}

// Embedded resources: parent table -> { embed name: [child table, kind, parent column, child column] }.
const RELATIONS = {
  fx_reports: {
    fx_subjects: ['fx_subjects', 'one', 'subject_id', 'id'],
    'fx_accounts!fx_reports_reporter_account_id_fkey': ['fx_accounts', 'one', 'reporter_account_id', 'id'],
  },
  fx_searches: { fx_accounts: ['fx_accounts', 'one', 'account_id', 'id'] },
  fx_api_access: { fx_accounts: ['fx_accounts', 'one', 'account_id', 'id'] },
  fx_disputes: {
    fx_dispute_files: ['fx_dispute_files', 'many', 'id', 'dispute_id'],
    fx_accounts: ['fx_accounts', 'one', 'account_id', 'id'],
    fx_reports: ['fx_reports', 'one', 'report_id', 'id'],
  },
  fx_subject_links: { fx_accounts: ['fx_accounts', 'one', 'account_id', 'id'] },
  fx_subject_emails: { 'fx_subjects!inner': ['fx_subjects', 'one', 'subject_id', 'id'] },
};

// Split a select list on top-level commas and pick out embeds: "alias:table!fk(cols)" or "table(cols)".
function parseEmbeds(cols) {
  const parts = []; let depth = 0; let cur = '';
  for (const ch of String(cols || '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.map(p => /^(?:([a-z_]+):)?([a-z_]+(?:![a-z_]+)?)\((.*)\)$/s.exec(p)).filter(Boolean)
    .map(m => ({ alias: m[1] || m[2].split('!')[0], rel: m[2], cols: m[3] }));
}

const getPath = (r, c) => {
  if (/^[a-z_]+\.[a-z_]+$/.test(c)) { const [e, f] = c.split('.'); return r[e] ? r[e][f] : undefined; } // embedded field
  const m = /^([a-z_]+)->>([a-z_]+)$/.exec(c);
  if (!m) return r[c];
  const v = r[m[1]] && r[m[1]][m[2]];
  return v == null ? null : String(v);
};

function likeMatch(value, pattern) {
  if (value == null) return false;
  const re = new RegExp(`^${pattern.split('%').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(String(value));
}

function createFake(seed = {}) {
  const tables = {};
  const files = {}; // storage: "bucket/path" -> { buffer, contentType }
  let serial = 1;
  const t = name => (tables[name] ||= []);
  for (const [name, rows] of Object.entries(seed)) for (const r of rows) t(name).push(generate(name, { ...r }));

  const now = () => new Date().toISOString();
  const withDefaults = (table, row) => generate(table, {
    ...(NO_ID.has(table) ? {} : { id: INT_IDS.has(table) ? serial++ : crypto.randomUUID() }),
    created_at: now(), updated_at: now(),
    ...JSON.parse(JSON.stringify(DEFAULTS[table] || {})), ...row,
  });

  const conflict = (table, row, ignore) => (UNIQUE[table] || []).some(([cols, where]) =>
    cols.every(c => row[c] != null) && (!where || where(row))
    && t(table).some(o => o !== ignore && (!where || where(o)) && cols.every(c => o[c] === row[c])));

  function embed(table, row, embeds) {
    for (const e of embeds) {
      const rel = (RELATIONS[table] || {})[e.rel];
      if (!rel) throw new Error(`fake: no relation ${table} -> ${e.rel}`);
      const [child, kind, pcol, ccol] = rel;
      const hits = t(child).filter(c => c[ccol] === row[pcol]).map(c => ({ ...c }));
      row[e.alias] = kind === 'one' ? (hits[0] || null) : hits;
    }
    return row;
  }

  function query(table) {
    const q = { op: 'select', filters: [], orders: [], limitN: null, mode: 'many', count: null, head: false, payload: null, returning: false, embeds: [], upsert: null };
    const api = {
      select(cols, opts = {}) {
        if (q.op === 'select') { q.count = opts.count || null; q.head = Boolean(opts.head); q.embeds = parseEmbeds(cols); } else q.returning = true;
        return api;
      },
      insert(rows) { q.op = 'insert'; q.payload = Array.isArray(rows) ? rows : [rows]; return api; },
      upsert(rows, opts = {}) { q.op = 'insert'; q.payload = Array.isArray(rows) ? rows : [rows]; q.upsert = opts; return api; },
      update(obj) { q.op = 'update'; q.payload = obj; return api; },
      delete() { q.op = 'delete'; return api; },
      eq(c, v) { q.filters.push(r => getPath(r, c) === v); return api; },
      neq(c, v) { q.filters.push(r => getPath(r, c) !== v); return api; },
      is(c, v) { q.filters.push(r => (r[c] ?? null) === v); return api; },
      gt(c, v) { q.filters.push(r => r[c] != null && r[c] > v); return api; },
      gte(c, v) { q.filters.push(r => r[c] != null && r[c] >= v); return api; },
      lt(c, v) { q.filters.push(r => r[c] != null && r[c] < v); return api; },
      lte(c, v) { q.filters.push(r => r[c] != null && r[c] <= v); return api; },
      not(c, op, v) {
        if (op === 'is') q.filters.push(r => (r[c] ?? null) !== v);
        else if (op === 'eq') q.filters.push(r => r[c] !== v);
        else if (op === 'ilike') q.filters.push(r => r[c] != null && !likeMatch(r[c], v)); // SQL: NULL never matches
        else throw new Error(`fake not(): unsupported ${op}`);
        return api;
      },
      in(c, vs) { q.filters.push(r => vs.includes(r[c])); return api; },
      overlaps(c, vs) { q.filters.push(r => Array.isArray(r[c]) && r[c].some(x => vs.includes(x))); return api; },
      ilike(c, pattern) { q.filters.push(r => likeMatch(r[c], pattern)); return api; },
      or(expr) {
        const conds = expr.split(',').map(part => {
          const [col, op, ...rest] = part.split('.');
          const val = rest.join('.');
          if (op === 'ilike') return r => likeMatch(r[col], val);
          if (op === 'eq') return r => String(r[col]) === val;
          throw new Error(`fake or(): unsupported ${op}`);
        });
        q.filters.push(r => conds.some(f => f(r)));
        return api;
      },
      order(c, { ascending = true } = {}) { q.orders.push([c, ascending]); return api; },
      limit(n) { q.limitN = n; return api; },
      range(from, to) { q.rangeFrom = from; q.rangeTo = to; return api; },
      single() { q.mode = 'single'; return api; },
      maybeSingle() { q.mode = 'maybe'; return api; },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); },
    };

    function shape(rows) {
      if (q.mode === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: `expected 1 row, got ${rows.length}` } };
      if (q.mode === 'maybe') return rows.length > 1 ? { data: null, error: { message: 'multiple rows' } } : { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    }

    function run() {
      const rows = t(table);
      const match = r => q.filters.every(f => f(r));
      if (q.op === 'insert') {
        const added = [];
        for (const raw of q.payload) {
          const row = withDefaults(table, raw);
          if (conflict(table, row)) {
            if (q.upsert && q.upsert.ignoreDuplicates) continue;
            if (q.upsert) {
              const cols = String(q.upsert.onConflict || 'id').split(',').map(s => s.trim());
              const existing = rows.find(o => cols.every(c => o[c] === row[c]));
              if (existing) { Object.assign(existing, generate(table, { ...existing, ...raw, updated_at: now() })); added.push(existing); continue; }
            }
            return { data: null, error: { code: '23505', message: `duplicate key on ${table}` } };
          }
          rows.push(row);
          added.push(row);
        }
        return q.returning ? shape(added.map(r => ({ ...r }))) : { data: null, error: null };
      }
      if ((q.op === 'update' || q.op === 'delete') && APPEND_ONLY.has(table)) {
        return { data: null, error: { code: 'P0001', message: `${table} is append-only: entries cannot be changed or deleted` } };
      }
      if (q.op === 'update') {
        const hit = rows.filter(match);
        for (const r of hit) {
          const next = generate(table, { ...r, ...q.payload, updated_at: now() });
          if (conflict(table, next, r)) return { data: null, error: { code: '23505', message: `duplicate key on ${table}` } };
          Object.assign(r, next);
        }
        return q.returning ? shape(hit.map(r => ({ ...r }))) : { data: null, error: null };
      }
      if (q.op === 'delete') {
        tables[table] = rows.filter(r => !match(r));
        return { data: null, error: null };
      }
      // Embed first so filters can use embedded fields; "!inner" embeds drop rows with no match.
      let out = rows.map(r => embed(table, { ...r }, q.embeds))
        .filter(r => q.embeds.every(e => !/!inner$/.test(e.rel) || r[e.alias]))
        .filter(match);
      for (const [c, asc] of [...q.orders].reverse()) {
        out.sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (asc ? 1 : -1)));
      }
      const count = out.length;
      if (q.rangeFrom != null) out = out.slice(q.rangeFrom, q.rangeTo + 1);
      if (q.limitN != null) out = out.slice(0, q.limitN);
      if (q.head) return { data: null, count, error: null };
      return { ...shape(out), count: q.count ? count : null };
    }
    return api;
  }

  const storage = {
    from(bucket) {
      const key = p => `${bucket}/${p}`;
      return {
        async upload(path, buffer, opts = {}) {
          if (files[key(path)] && !opts.upsert) return { data: null, error: { message: 'The resource already exists' } };
          files[key(path)] = { buffer: Buffer.from(buffer), contentType: opts.contentType };
          return { data: { path }, error: null };
        },
        async download(path) {
          const f = files[key(path)];
          if (!f) return { data: null, error: { message: 'Object not found' } };
          return { data: new Blob([f.buffer], { type: f.contentType }), error: null };
        },
        async createSignedUrl(path, seconds) {
          if (!files[key(path)]) return { data: null, error: { message: 'Object not found' } };
          return { data: { signedUrl: `https://storage.test/${key(path)}?expires=${seconds}` }, error: null };
        },
        async remove(paths) {
          for (const p of paths) delete files[key(p)];
          return { data: paths.map(name => ({ name })), error: null };
        },
      };
    },
  };

  return { from: query, storage, tables, files };
}

module.exports = { createFake };
