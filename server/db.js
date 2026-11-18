'use strict';
/**
 * Audit database adapter — one async API, two drivers:
 *   • Postgres (Neon / Vercel / any) when DATABASE_URL or POSTGRES_URL is set — used in production
 *   • SQLite (Node's built-in node:sqlite) otherwise — zero-setup local development
 * Queries are written once with `?` placeholders; the Postgres driver rewrites them to $1, $2…
 * Timestamps are stored as UTC text 'YYYY-MM-DD HH:MM:SS' in both drivers.
 */
const path = require('path');
const fs = require('fs');

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const IS_PG = !!PG_URL;
const NOW_PG = "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')";

function schema(pg) {
  const ID = pg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const REAL = pg ? 'DOUBLE PRECISION' : 'REAL';
  const NOW = pg ? NOW_PG : "(datetime('now'))";
  return `
CREATE TABLE IF NOT EXISTS users (id ${ID}, name TEXT NOT NULL, email TEXT, role TEXT NOT NULL CHECK (role IN ('admin','pm','developer','seo')), created_at TEXT DEFAULT ${NOW});
CREATE TABLE IF NOT EXISTS projects (id ${ID}, name TEXT NOT NULL, url TEXT NOT NULL, notes TEXT, created_at TEXT DEFAULT ${NOW});
CREATE TABLE IF NOT EXISTS audits (
  id ${ID}, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', options TEXT, progress TEXT, site TEXT, score ${REAL}, readiness TEXT, readiness_pct ${REAL},
  category_scores TEXT, counts TEXT, standards_version INTEGER, pages_scanned INTEGER DEFAULT 0, error TEXT,
  cancel_requested INTEGER DEFAULT 0, started_at TEXT DEFAULT ${NOW}, updated_at TEXT DEFAULT ${NOW}, finished_at TEXT);
CREATE TABLE IF NOT EXISTS pages (id ${ID}, audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE, url TEXT NOT NULL, status_code INTEGER, depth INTEGER, page_type TEXT, indexable INTEGER, score ${REAL}, data TEXT);
CREATE INDEX IF NOT EXISTS idx_pages_audit ON pages(audit_id);
CREATE TABLE IF NOT EXISTS issues (
  id ${ID}, audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE, rule_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  severity TEXT NOT NULL, category TEXT NOT NULL, url TEXT, title TEXT NOT NULL, current_value TEXT, detail TEXT, source TEXT DEFAULT 'auto',
  status TEXT NOT NULL DEFAULT 'open', assignee TEXT, notes TEXT DEFAULT '[]', created_at TEXT DEFAULT ${NOW}, resolved_at TEXT);
CREATE INDEX IF NOT EXISTS idx_issues_audit ON issues(audit_id);
CREATE TABLE IF NOT EXISTS rule_results (audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE, rule_id TEXT NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, evaluated INTEGER NOT NULL, failed INTEGER NOT NULL, PRIMARY KEY (audit_id, rule_id));
CREATE TABLE IF NOT EXISTS standards (rule_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT DEFAULT ${NOW}, updated_by TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checklist (audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE, item_key TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0, checked_by TEXT, checked_at TEXT, PRIMARY KEY (audit_id, item_key));
CREATE TABLE IF NOT EXISTS chat_messages (id ${ID}, audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT ${NOW});
`;
}

// ───────────────────────── Postgres driver ─────────────────────────
function pgDriver() {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, v => parseInt(v, 10));      // int8 (COUNT) → number
  types.setTypeParser(1700, v => parseFloat(v));      // numeric → number
  const local = /localhost|127\.0\.0\.1/.test(PG_URL);
  const pool = new Pool({ connectionString: PG_URL, max: Number(process.env.PG_POOL_MAX || 5), ssl: local ? false : { rejectUnauthorized: false }, idleTimeoutMillis: 10000 });
  try { require('@vercel/functions').attachDatabasePool(pool); } catch { /* not on Vercel */ }

  const toPg = (sql) => { let i = 0; return sql.replace(/datetime\('now'\)/g, NOW_PG).replace(/\?/g, () => '$' + (++i)); };
  const make = (q) => ({
    all: async (sql, ...p) => (await q(toPg(sql), p)).rows,
    get: async (sql, ...p) => (await q(toPg(sql), p)).rows[0],
    run: async (sql, ...p) => { const r = await q(toPg(sql), p); return { changes: r.rowCount }; },
    insert: async (sql, ...p) => (await q(toPg(sql) + ' RETURNING id', p)).rows[0].id,
  });
  const api = make((s, p) => pool.query(s, p));
  return {
    ...api,
    async tx(fn) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const r = await fn(make((s, p) => client.query(s, p))); await client.query('COMMIT'); return r; }
      catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    },
    async init() {
      await pool.query(schema(true));
      await pool.query('ALTER TABLE audits ADD COLUMN IF NOT EXISTS cancel_requested INTEGER DEFAULT 0');
      await pool.query(`ALTER TABLE audits ADD COLUMN IF NOT EXISTS updated_at TEXT DEFAULT ${NOW_PG}`);
    },
  };
}

// ───────────────────────── SQLite driver (local dev) ─────────────────────────
function sqliteDriver() {
  process.removeAllListeners('warning'); // silence the node:sqlite ExperimentalWarning
  const { DatabaseSync } = require('node:sqlite');
  // On Vercel without Postgres only /tmp is writable — data is temporary there (demo mode).
  const dir = process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/seo-checker' : path.join(__dirname, '..', 'data'));
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'seo-checker.db'));
  const api = {
    all: async (sql, ...p) => db.prepare(sql).all(...p),
    get: async (sql, ...p) => db.prepare(sql).get(...p),
    run: async (sql, ...p) => { const r = db.prepare(sql).run(...p); return { changes: r.changes }; },
    insert: async (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid),
  };
  let chain = Promise.resolve(); // serialise transactions on the single connection
  return {
    ...api,
    tx(fn) {
      const next = chain.then(async () => {
        db.exec('BEGIN');
        try { const r = await fn(api); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
      });
      chain = next.catch(() => {});
      return next;
    },
    async init() {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      db.exec(schema(false));
      for (const col of ['cancel_requested INTEGER DEFAULT 0', 'updated_at TEXT']) { try { db.exec(`ALTER TABLE audits ADD COLUMN ${col}`); } catch { /* exists */ } }
    },
  };
}

const driver = IS_PG ? pgDriver() : sqliteDriver();

const J = (v, fallback = null) => {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
};

/** Multi-row insert, chunked to stay under parameter limits. `t` may be a transaction handle. */
async function insertMany(t, table, cols, rows, chunk = 200) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const ph = part.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
    await t.run(`INSERT INTO ${table}(${cols.join(',')}) VALUES ${ph}`, ...part.flat());
  }
}

async function getSetting(key, fallback) {
  const row = await driver.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? J(row.value, fallback) : fallback;
}
async function setSetting(key, value) {
  await driver.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

let initPromise = null;
const ready = () => (initPromise ||= driver.init().catch(e => { initPromise = null; throw e; }));

module.exports = {
  IS_PG, ready, J, insertMany, getSetting, setSetting,
  all: (...a) => driver.all(...a), get: (...a) => driver.get(...a), run: (...a) => driver.run(...a),
  insert: (...a) => driver.insert(...a), tx: (fn) => driver.tx(fn),
};
