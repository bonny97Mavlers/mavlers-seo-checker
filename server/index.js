'use strict';
/**
 * Mavlers SEO Pre-Launch Checker — API server.
 * Runs as a normal Node server (npm start) or as a Vercel function (api/index.js imports this app).
 * Everything that touches the target website runs here on the server.
 */
const path = require('path');
const express = require('express');
const { all, get, run, insert, J, ready, IS_PG } = require('./db');
const standardsSvc = require('./engine/standards');
const { crawl, makeProgress, getProgress, cancelAudit, live, cancelled } = require('./crawler/crawlManager');
const { analyseAndPersist, recomputeReadiness, checklistState, pathKey } = require('./engine/analyse');
const { normaliseInput, ALLOW_PRIVATE } = require('./crawler/urlGuard');
const assistant = require('./ai/assistant');
const reports = require('./reports');
const { MANUAL_CHECKLIST } = require('./engine/defaultStandards');

// Keeps a background crawl alive after the HTTP response on Vercel; a no-op elsewhere.
let waitUntil = (p) => p;
try { if (process.env.VERCEL) waitUntil = require('@vercel/functions').waitUntil; } catch { /* local */ }

const nowText = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// One-time init per instance: schema, default standards, starter users.
let bootPromise = null;
const boot = () => (bootPromise ||= (async () => {
  await ready();
  await standardsSvc.seed();
  if (!(await get('SELECT id FROM users LIMIT 1'))) {
    for (const [name, role] of [['Admin', 'admin'], ['Project Manager', 'pm'], ['Developer', 'developer'], ['SEO Specialist', 'seo']]) await run('INSERT INTO users(name, role) VALUES(?, ?)', name, role);
  }
})().catch(e => { bootPromise = null; throw e; }));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });

// ───────── auth + roles ─────────
// Optional shared API token (set API_TOKEN). Roles come from the X-User-Id header — role scaffolding for the
// MVP; plug SSO (Google Workspace) in here for real authentication.
const PERMS = {
  admin: ['*'],
  pm: ['audit:run', 'issue:status', 'issue:assign', 'issue:ignore', 'checklist', 'report', 'project:edit'],
  seo: ['audit:run', 'issue:status', 'issue:assign', 'issue:ignore', 'standards:edit', 'report'],
  developer: ['issue:status', 'report'],
};
app.use('/api', async (req, res, next) => {
  try { await boot(); } catch (e) { console.error('boot failed', e); return res.status(503).json({ error: 'Database unavailable: ' + e.message }); }
  if (process.env.API_TOKEN && req.path !== '/health') {
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || (req.method === 'GET' ? String(req.query.token || '') : '');
    if (tok !== process.env.API_TOKEN) return res.status(401).json({ error: 'Unauthorised', needsToken: true });
  }
  const uid = Number(req.headers['x-user-id']) || (req.method === 'GET' ? Number(req.query.uid) : 0) || 0;
  req.user = (uid && await get('SELECT * FROM users WHERE id = ?', uid)) || await get("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  next();
});
const can = (user, perm) => !!user && (PERMS[user.role]?.includes('*') || PERMS[user.role]?.includes(perm));
const need = (perm) => (req, res, next) => can(req.user, perm) ? next() : res.status(403).json({ error: `Your role (${req.user?.role}) cannot do this.` });

// tiny in-memory rate limiter for audit creation (per instance)
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip + req.path; const now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < windowMs); arr.push(now); hits.set(k, arr);
    if (arr.length > max) return res.status(429).json({ error: 'Too many audits started — please wait a minute.' });
    next();
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.message || 'Server error' }); });
const auditRow = (a) => a && ({ ...a, options: J(a.options, {}), progress: J(a.progress, null), site: J(a.site, null), category_scores: J(a.category_scores, null), counts: J(a.counts, null) });

// ───────── meta ─────────
app.get('/api/health', wrap(async (req, res) => res.json({ ok: true, db: IS_PG ? 'postgres' : 'sqlite', ai: assistant.hasLLM(), model: assistant.hasLLM() ? assistant.MODEL : null, pagespeed: !!process.env.PAGESPEED_API_KEY, standardsVersion: await standardsSvc.version(), allowPrivate: ALLOW_PRIVATE, vercel: !!process.env.VERCEL })));
app.get('/api/me', (req, res) => res.json({ user: req.user, permissions: PERMS[req.user.role] }));
app.get('/api/users', wrap(async (req, res) => res.json(await all('SELECT * FROM users ORDER BY id'))));
app.post('/api/users', need('users:manage'), wrap(async (req, res) => {
  const { name, email, role } = req.body;
  if (!name || !PERMS[role]) return res.status(400).json({ error: 'Name and a valid role are required' });
  const id = await insert('INSERT INTO users(name, email, role) VALUES(?,?,?)', name, email || null, role);
  res.json(await get('SELECT * FROM users WHERE id = ?', id));
}));
app.delete('/api/users/:id', need('users:manage'), wrap(async (req, res) => { await run('DELETE FROM users WHERE id = ? AND role != ?', req.params.id, 'admin'); res.json({ ok: true }); }));

// ───────── projects ─────────
app.get('/api/projects', wrap(async (req, res) => {
  const projects = await all('SELECT * FROM projects ORDER BY created_at DESC, id DESC');
  res.json(await Promise.all(projects.map(async p => {
    const latest = await get("SELECT id, score, readiness, readiness_pct, counts, finished_at, pages_scanned FROM audits WHERE project_id = ? AND status = 'complete' ORDER BY id DESC LIMIT 1", p.id);
    const running = await get("SELECT id, status FROM audits WHERE project_id = ? AND status IN ('queued','crawling','analysing') ORDER BY id DESC LIMIT 1", p.id);
    const auditCount = (await get('SELECT COUNT(*) AS n FROM audits WHERE project_id = ?', p.id)).n;
    return { ...p, latest: latest ? { ...latest, counts: J(latest.counts, {}) } : null, running, auditCount };
  })));
}));
app.post('/api/projects', need('audit:run'), wrap(async (req, res) => {
  const u = normaliseInput(req.body.url);
  const id = await insert('INSERT INTO projects(name, url) VALUES(?, ?)', (req.body.name || u.hostname).slice(0, 120), u.href);
  res.json(await get('SELECT * FROM projects WHERE id = ?', id));
}));
app.get('/api/projects/:id', wrap(async (req, res) => {
  const p = await get('SELECT * FROM projects WHERE id = ?', req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  res.json({ ...p, audits: (await all('SELECT id, url, status, score, readiness, readiness_pct, counts, pages_scanned, standards_version, options, started_at, finished_at, error FROM audits WHERE project_id = ? ORDER BY id DESC', p.id)).map(auditRow) });
}));
app.patch('/api/projects/:id', need('project:edit'), wrap(async (req, res) => {
  const p = await get('SELECT * FROM projects WHERE id = ?', req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  await run('UPDATE projects SET name = ?, notes = ? WHERE id = ?', (req.body.name ?? p.name).slice(0, 120), req.body.notes ?? p.notes, p.id);
  res.json(await get('SELECT * FROM projects WHERE id = ?', p.id));
}));
app.delete('/api/projects/:id', need('projects:delete'), wrap(async (req, res) => { await run('DELETE FROM projects WHERE id = ?', req.params.id); res.json({ ok: true }); }));

// ───────── audits ─────────
let running = 0;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_AUDITS || 2);
const waiting = [];
const acquire = () => new Promise(r => { if (running < MAX_CONCURRENT) { running++; r(); } else waiting.push(r); });
const release = () => { running--; const n = waiting.shift(); if (n) { running++; n(); } };

async function runAudit(auditId, projectId, url, options) {
  const p = makeProgress(auditId);
  p.phase = 'Queued'; p.status = 'queued'; await p.save(true);
  await acquire();
  try {
    p.status = 'crawling'; await p.save(true);
    const { pages, site } = await crawl(auditId, url, options, p);
    p.phase = 'Applying Mavlers SEO standards'; p.status = 'analysing'; p.current = null; await p.save(true);
    await analyseAndPersist(auditId, projectId, pages, site);
    p.phase = 'Complete'; p.status = 'complete'; await p.save(true);
  } catch (e) {
    console.error(`audit ${auditId} failed:`, e.message);
    p.phase = 'Failed'; p.status = 'failed'; p.err(e.message); await p.save(true);
    await run("UPDATE audits SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?", e.message, auditId).catch(() => {});
  } finally {
    release(); cancelled.delete(auditId);
    setTimeout(() => live.delete(auditId), 60000).unref?.();
  }
}

app.post('/api/audits', need('audit:run'), rateLimit(10, 60000), wrap(async (req, res) => {
  const { url, projectId, projectName, options = {} } = req.body;
  const u = normaliseInput(url);
  let project = projectId ? await get('SELECT * FROM projects WHERE id = ?', projectId) : null;
  if (!project) project = await get('SELECT * FROM projects WHERE url = ? OR url = ?', u.href, u.href.replace(/\/$/, ''));
  if (!project) {
    const id = await insert('INSERT INTO projects(name, url) VALUES(?, ?)', (projectName || u.hostname.replace(/^www\./, '')).slice(0, 120), u.href);
    project = await get('SELECT * FROM projects WHERE id = ?', id);
  }
  const opts = {
    maxPages: Math.max(1, Math.min(Number(options.maxPages) || 25, Number(process.env.MAX_PAGES_HARD || 500))),
    sitemap: options.sitemap !== false, internalLinks: options.internalLinks !== false, externalLinks: !!options.externalLinks,
    images: options.images !== false, structuredData: options.structuredData !== false, technical: options.technical !== false,
  };
  const auditId = await insert("INSERT INTO audits(project_id, url, status, options) VALUES(?, ?, 'queued', ?)", project.id, u.href, JSON.stringify({ ...opts, startedBy: req.user.name }));
  waitUntil(runAudit(auditId, project.id, u.href, opts));
  res.json({ auditId, projectId: project.id });
}));

app.get('/api/audits', wrap(async (req, res) => {
  const where = req.query.projectId ? 'WHERE a.project_id = ?' : '';
  const params = req.query.projectId ? [req.query.projectId] : [];
  res.json((await all(`SELECT a.id, a.project_id, a.url, a.status, a.score, a.readiness, a.readiness_pct, a.counts, a.pages_scanned, a.standards_version, a.options, a.started_at, a.finished_at, a.error, p.name AS project_name FROM audits a JOIN projects p ON p.id = a.project_id ${where} ORDER BY a.id DESC LIMIT 300`, ...params)).map(auditRow));
}));
app.get('/api/audits/:id', wrap(async (req, res) => {
  const a = await get('SELECT a.*, p.name AS project_name FROM audits a JOIN projects p ON p.id = a.project_id WHERE a.id = ?', req.params.id);
  if (!a) return res.status(404).json({ error: 'Audit not found' });
  const out = auditRow(a);
  if (a.status === 'complete') {
    const prev = await get("SELECT id, score, counts FROM audits WHERE project_id = ? AND id < ? AND status = 'complete' ORDER BY id DESC LIMIT 1", a.project_id, a.id);
    out.previous = prev ? { id: prev.id, score: prev.score, counts: J(prev.counts, {}) } : null;
    out.rules = await all('SELECT * FROM rule_results WHERE audit_id = ?', a.id);
  }
  res.json(out);
}));
app.get('/api/audits/:id/progress', wrap(async (req, res) => {
  const p = await getProgress(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Audit not found' });
  const { save, log, err, cancelRequested, ...rest } = p;
  res.json(rest);
}));
app.post('/api/audits/:id/cancel', need('audit:run'), wrap(async (req, res) => { await cancelAudit(Number(req.params.id)); res.json({ ok: true }); }));
app.delete('/api/audits/:id', need('audit:run'), wrap(async (req, res) => { await run('DELETE FROM audits WHERE id = ?', req.params.id); res.json({ ok: true }); }));

app.get('/api/audits/:id/pages', wrap(async (req, res) => {
  const rows = await all('SELECT id, url, status_code, depth, page_type, indexable, score, data FROM pages WHERE audit_id = ? ORDER BY depth, url', req.params.id);
  const issueCounts = {};
  for (const i of await all("SELECT url, severity FROM issues WHERE audit_id = ? AND status IN ('open','in_progress')", req.params.id)) {
    const c = (issueCounts[i.url] ||= { critical: 0, warning: 0 }); c[i.severity]++;
  }
  res.json(rows.map(r => {
    const d = J(r.data, {}); const pg = d.page;
    return {
      id: r.id, url: r.url, status: r.status_code, depth: r.depth, type: r.page_type, indexable: !!r.indexable, score: r.score,
      redirectOnly: d.redirectOnly, finalUrl: d.finalUrl, error: d.error, inSitemap: d.inSitemap,
      title: pg?.title, titleLength: pg?.titleLength, meta: pg?.metaDescription, metaLength: pg?.metaLength, h1: pg?.h1s?.[0], h1Count: pg?.h1s?.length,
      words: pg?.wordCount, inlinks: d.inlinks?.length || 0, outlinks: d.outlinks?.length || 0, externalLinks: pg?.externalLinks?.length || 0,
      images: pg?.images?.length || 0, imagesNoAlt: pg ? pg.images.filter(i => i.alt === null && !i.decorative).length : 0,
      schema: pg?.schemaTypes || [], canonical: pg?.canonical, noindex: pg?.noindex, topic: (d.topic || []).join(' '), ttfb: d.ttfb,
      issues: issueCounts[r.url] || { critical: 0, warning: 0 },
    };
  }));
}));
app.get('/api/pages/:id', wrap(async (req, res) => {
  const r = await get('SELECT * FROM pages WHERE id = ?', req.params.id);
  if (!r) return res.status(404).json({ error: 'Page not found' });
  const issues = (await all('SELECT * FROM issues WHERE audit_id = ? ORDER BY severity', r.audit_id))
    .filter(i => { const d = J(i.detail, {}) || {}; return i.url === r.url || (d.urls || []).includes(r.url) || (d.pages || []).includes(r.url) || (d.sources || []).includes(r.url); })
    .map(i => ({ ...i, detail: J(i.detail), linkedFromHere: i.url !== r.url }));
  const audit = await get('SELECT site FROM audits WHERE id = ?', r.audit_id);
  res.json({ ...r, data: J(r.data, {}), issues, cwv: J(audit.site, {})?.cwv || null });
}));

// ───────── issues ─────────
app.get('/api/audits/:id/issues', wrap(async (req, res) => {
  const stds = await standardsSvc.byId();
  let rows = await all("SELECT * FROM issues WHERE audit_id = ? ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, category, rule_id, url", req.params.id);
  const { severity, category, status, assignee, q, url, rule } = req.query;
  if (severity) rows = rows.filter(r => r.severity === severity);
  if (category) rows = rows.filter(r => r.category === category);
  if (rule) rows = rows.filter(r => r.rule_id === rule);
  if (status === 'unresolved') rows = rows.filter(r => r.status === 'open' || r.status === 'in_progress');
  else if (status) rows = rows.filter(r => r.status === status);
  if (assignee) rows = rows.filter(r => (r.assignee || '') === (assignee === '__none' ? '' : assignee));
  if (url) rows = rows.filter(r => (r.url || '').includes(url));
  if (q) { const s = q.toLowerCase(); rows = rows.filter(r => `${r.title} ${r.url} ${r.current_value} ${stds[r.rule_id]?.name}`.toLowerCase().includes(s)); }
  res.json(rows.map(r => ({ ...r, detail: J(r.detail), notes: J(r.notes, []), standard: stds[r.rule_id] ? { name: stds[r.rule_id].name, requirement: stds[r.rule_id].requirement } : null })));
}));
app.get('/api/issues/:id', wrap(async (req, res) => {
  const i = await get('SELECT * FROM issues WHERE id = ?', req.params.id);
  if (!i) return res.status(404).json({ error: 'Issue not found' });
  const page = await get('SELECT id FROM pages WHERE audit_id = ? AND url = ?', i.audit_id, i.url);
  const prev = await get('SELECT a.id, i2.status FROM audits a JOIN issues i2 ON i2.audit_id = a.id WHERE a.project_id = (SELECT project_id FROM audits WHERE id = ?) AND a.id < ? AND i2.fingerprint = ? ORDER BY a.id DESC LIMIT 1', i.audit_id, i.audit_id, i.fingerprint);
  res.json({ ...i, detail: J(i.detail), notes: J(i.notes, []), standard: (await standardsSvc.byId())[i.rule_id] || null, pageId: page?.id || null, seenBefore: prev || null });
}));
app.patch('/api/issues/:id', wrap(async (req, res) => {
  const i = await get('SELECT * FROM issues WHERE id = ?', req.params.id);
  if (!i) return res.status(404).json({ error: 'Issue not found' });
  const { status, assignee, note } = req.body;
  const notes = J(i.notes, []);
  if (status && status !== i.status) {
    if (!['open', 'in_progress', 'resolved', 'ignored'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    if (status === 'ignored' && !can(req.user, 'issue:ignore')) return res.status(403).json({ error: 'Your role cannot ignore issues.' });
    if (!can(req.user, 'issue:status')) return res.status(403).json({ error: 'Your role cannot change issue status.' });
    notes.push({ by: req.user.name, at: new Date().toISOString(), text: `Status changed: ${i.status.replace('_', ' ')} → ${status.replace('_', ' ')}`, system: true });
    await run('UPDATE issues SET status = ?, resolved_at = ? WHERE id = ?', status, ['resolved', 'ignored'].includes(status) ? nowText() : null, i.id);
  }
  if (assignee !== undefined && assignee !== i.assignee) {
    if (!can(req.user, 'issue:assign')) return res.status(403).json({ error: 'Your role cannot assign issues.' });
    notes.push({ by: req.user.name, at: new Date().toISOString(), text: assignee ? `Assigned to ${assignee}` : 'Unassigned', system: true });
    await run('UPDATE issues SET assignee = ? WHERE id = ?', assignee || null, i.id);
  }
  if (note && String(note).trim()) notes.push({ by: req.user.name, at: new Date().toISOString(), text: String(note).slice(0, 2000) });
  await run('UPDATE issues SET notes = ? WHERE id = ?', JSON.stringify(notes), i.id);
  const readiness = await recomputeReadiness(i.audit_id);
  res.json({ issue: { ...(await get('SELECT * FROM issues WHERE id = ?', i.id)), notes, detail: J(i.detail) }, readiness });
}));
app.post('/api/issues/bulk', wrap(async (req, res) => {
  const { ids = [], status } = req.body;
  if (!['open', 'in_progress', 'resolved', 'ignored'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (!can(req.user, status === 'ignored' ? 'issue:ignore' : 'issue:status')) return res.status(403).json({ error: 'Not permitted for your role.' });
  let auditId = null;
  for (const id of ids.slice(0, 500)) {
    const i = await get('SELECT * FROM issues WHERE id = ?', id); if (!i) continue; auditId = i.audit_id;
    const notes = J(i.notes, []); notes.push({ by: req.user.name, at: new Date().toISOString(), text: `Status changed: ${i.status} → ${status} (bulk)`, system: true });
    await run('UPDATE issues SET status = ?, notes = ?, resolved_at = ? WHERE id = ?', status, JSON.stringify(notes), ['resolved', 'ignored'].includes(status) ? nowText() : null, id);
  }
  res.json({ ok: true, readiness: auditId ? await recomputeReadiness(auditId) : null });
}));
app.post('/api/issues/:id/suggest', wrap(async (req, res) => res.json(await assistant.suggestFix(Number(req.params.id)))));

// ───────── readiness checklist ─────────
app.get('/api/audits/:id/checklist', wrap(async (req, res) => res.json(await checklistState(Number(req.params.id)))));
app.put('/api/audits/:id/checklist/:key', need('checklist'), wrap(async (req, res) => {
  if (!MANUAL_CHECKLIST.some(c => c.key === req.params.key)) return res.status(404).json({ error: 'Unknown checklist item' });
  await run(`INSERT INTO checklist(audit_id, item_key, checked, checked_by, checked_at) VALUES(?,?,?,?,?)
       ON CONFLICT(audit_id, item_key) DO UPDATE SET checked = excluded.checked, checked_by = excluded.checked_by, checked_at = excluded.checked_at`,
  Number(req.params.id), req.params.key, req.body.checked ? 1 : 0, req.user.name, nowText());
  res.json({ checklist: await checklistState(Number(req.params.id)), readiness: await recomputeReadiness(Number(req.params.id)) });
}));

// ───────── site structure ─────────
app.get('/api/audits/:id/structure', wrap(async (req, res) => {
  const rows = await all('SELECT id, url, status_code, page_type, indexable, score, data FROM pages WHERE audit_id = ? AND page_type IS NOT NULL', req.params.id);
  const issueCounts = {};
  for (const i of await all("SELECT url, severity FROM issues WHERE audit_id = ? AND status IN ('open','in_progress')", req.params.id)) { const c = (issueCounts[i.url] ||= { critical: 0, warning: 0 }); c[i.severity]++; }
  const root = { name: 'Homepage', path: '/', children: {} };
  for (const r of rows) {
    const d = J(r.data, {});
    const u = new URL(r.url);
    const segs = u.pathname.split('/').filter(Boolean);
    let node = root; let acc = '';
    for (const s of segs) { acc += '/' + s; node.children[s] ||= { name: s, path: acc, children: {} }; node = node.children[s]; }
    if (u.search) { node.children[u.search] ||= { name: u.search, path: acc + u.search, children: {} }; node = node.children[u.search]; }
    const inl = d.inlinks?.length || 0;
    Object.assign(node, {
      pageId: r.id, url: r.url, status: r.status_code, type: r.page_type, indexable: !!r.indexable, score: r.score, title: d.page?.h1s?.[0] || d.page?.title || null,
      inlinks: inl, outlinks: d.outlinks?.length || 0, issues: issueCounts[r.url] || { critical: 0, warning: 0 },
      health: !r.indexable ? 'excluded' : r.page_type === 'home' ? 'good' : inl === 0 ? 'orphan' : inl <= 2 ? 'weak' : 'good',
    });
  }
  const toArr = (n) => ({ ...n, children: Object.values(n.children).sort((a, b) => a.path.localeCompare(b.path)).map(toArr) });
  res.json(toArr(root));
}));

// ───────── comparison ─────────
app.get('/api/compare', wrap(async (req, res) => {
  const A = await get("SELECT * FROM audits WHERE id = ? AND status = 'complete'", req.query.a);
  const B = await get("SELECT * FROM audits WHERE id = ? AND status = 'complete'", req.query.b);
  if (!A || !B) return res.status(404).json({ error: 'Both audits must be complete' });
  const [older, newer] = A.id < B.id ? [A, B] : [B, A];
  const stds = await standardsSvc.byId();
  const iA = await all('SELECT * FROM issues WHERE audit_id = ?', older.id); const iB = await all('SELECT * FROM issues WHERE audit_id = ?', newer.id);
  const fB = new Map(iB.map(i => [i.fingerprint, i])); const fA = new Map(iA.map(i => [i.fingerprint, i]));
  const slim = (i) => ({ id: i.id, rule: i.rule_id, standard: stds[i.rule_id]?.name, severity: i.severity, url: i.url, path: pathKey(i.url || ''), title: i.title, status: i.status });
  const checksPassed = async (id) => (await all('SELECT evaluated, failed FROM rule_results WHERE audit_id = ?', id)).reduce((s, r) => s + r.evaluated - r.failed, 0);
  const cA = J(older.category_scores, {}); const cB = J(newer.category_scores, {});
  res.json({
    older: { id: older.id, date: older.finished_at, score: older.score, readiness: older.readiness, counts: J(older.counts, {}), pages: older.pages_scanned, url: older.url, standardsVersion: older.standards_version },
    newer: { id: newer.id, date: newer.finished_at, score: newer.score, readiness: newer.readiness, counts: J(newer.counts, {}), pages: newer.pages_scanned, url: newer.url, standardsVersion: newer.standards_version },
    scoreDelta: Math.round((newer.score - older.score) * 10) / 10,
    checksPassedDelta: (await checksPassed(newer.id)) - (await checksPassed(older.id)),
    resolved: iA.filter(i => !fB.has(i.fingerprint)).map(slim),
    added: iB.filter(i => !fA.has(i.fingerprint)).map(slim),
    remaining: iB.filter(i => fA.has(i.fingerprint)).map(slim),
    categories: Object.keys({ ...cA, ...cB }).map(k => ({ key: k, label: (cB[k] || cA[k]).label, before: cA[k]?.score ?? null, after: cB[k]?.score ?? null })),
  });
}));

// ───────── standards library ─────────
app.get('/api/standards', wrap(async (req, res) => res.json({ version: await standardsSvc.version(), categories: standardsSvc.CATEGORIES, standards: await standardsSvc.list(), scoring: await standardsSvc.scoring() })));
app.patch('/api/standards/:id', need('standards:edit'), wrap(async (req, res) => res.json(await standardsSvc.update(req.params.id, req.body, req.user.name))));
app.post('/api/standards/:id/reset', need('standards:edit'), wrap(async (req, res) => res.json(await standardsSvc.resetToDefault(req.params.id, req.user.name))));
app.patch('/api/settings/scoring', need('standards:edit'), wrap(async (req, res) => res.json(await standardsSvc.updateScoring(req.body))));

// ───────── AI assistant ─────────
app.get('/api/audits/:id/chat', wrap(async (req, res) => res.json(await all('SELECT * FROM chat_messages WHERE audit_id = ? ORDER BY id', req.params.id))));
app.delete('/api/audits/:id/chat', wrap(async (req, res) => { await run('DELETE FROM chat_messages WHERE audit_id = ?', req.params.id); res.json({ ok: true }); }));
app.post('/api/audits/:id/chat', wrap(async (req, res) => {
  const msg = String(req.body.message || '').trim().slice(0, 4000);
  if (!msg) return res.status(400).json({ error: 'Message is required' });
  const a = await get("SELECT id FROM audits WHERE id = ? AND status = 'complete'", req.params.id);
  if (!a) return res.status(400).json({ error: 'The assistant needs a completed audit.' });
  const history = (await all('SELECT role, content FROM chat_messages WHERE audit_id = ? ORDER BY id DESC LIMIT 12', a.id)).reverse();
  await run('INSERT INTO chat_messages(audit_id, role, content) VALUES(?,?,?)', a.id, 'user', msg);
  const r = await assistant.ask(a.id, msg, history);
  await run('INSERT INTO chat_messages(audit_id, role, content) VALUES(?,?,?)', a.id, 'assistant', JSON.stringify({ text: r.answer, source: r.source }));
  res.json(r);
}));

// ───────── reports ─────────
app.get('/api/audits/:id/report', wrap(async (req, res) => {
  if (!can(req.user, 'report')) return res.status(403).send('Not permitted');
  res.type('html').send(req.query.type === 'client' ? await reports.clientReport(Number(req.params.id)) : await reports.internalReport(Number(req.params.id)));
}));
app.get('/api/audits/:id/issues.csv', wrap(async (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="seo-issues-audit-${req.params.id}.csv"`);
  res.type('text/csv').send(await reports.issuesCsv(Number(req.params.id)));
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = Number(process.env.PORT || 4300);
if (require.main === module) {
  boot().then(() => app.listen(PORT, () => console.log(`Mavlers SEO Pre-Launch Checker running on http://localhost:${PORT} · ${IS_PG ? 'Postgres' : 'SQLite'}${ALLOW_PRIVATE ? ' · private hosts allowed (dev mode)' : ''}`)))
    .catch(e => { console.error('Failed to start:', e); process.exit(1); });
}
module.exports = app;
