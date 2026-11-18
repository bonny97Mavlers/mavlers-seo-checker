import { api } from '../api.js';
import { esc, short, sevBadge, statusBadge, srcBadge, toast, debounce } from '../ui.js';

export const needsAudit = true;

export default async function render(el, params, app) {
  const a = app.audit;
  const q = app.query();
  const f = { severity: q.get('severity') || '', category: q.get('category') || '', status: q.get('status') ?? 'unresolved', assignee: q.get('assignee') || '', url: q.get('url') || '', q: q.get('q') || '', rule: q.get('rule') || '' };
  const stdRes = await api.get('/api/standards');
  const cats = stdRes.categories;
  const stdName = Object.fromEntries(stdRes.standards.map(s => [s.id, s.name]));

  el.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">Issues · Audit #${a.id}</span><h1>Issues</h1><p>Every finding against the Mavlers SEO standards. Click an issue for details, fixes and AI suggestions.</p></div>
    <a class="btn sm" href="${api.link(`/api/audits/${a.id}/issues.csv`)}">Export CSV</a></div>
  <div class="card" style="padding:14px">
    <div class="grid" style="grid-template-columns:repeat(6,minmax(0,1fr));gap:10px">
      <select class="select" data-f="severity"><option value="">All severities</option><option value="critical">🔴 Critical</option><option value="warning">🟠 Warning</option></select>
      <select class="select" data-f="category"><option value="">All categories</option>${Object.entries(cats).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select>
      <select class="select" data-f="status"><option value="unresolved">Unresolved</option><option value="">All statuses</option><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option><option value="ignored">Ignored</option></select>
      <select class="select" data-f="assignee"><option value="">Any assignee</option><option value="__none">Unassigned</option>${app.users.map(u => `<option value="${esc(u.name)}">${esc(u.name)}</option>`).join('')}</select>
      <input class="input" data-f="url" placeholder="Filter by URL…">
      <input class="input" data-f="q" placeholder="Search issues…">
    </div>
    ${f.rule ? `<div class="mt-s small">Standard: <b>${esc(stdName[f.rule] || f.rule)}</b> <a href="#" id="clearRule" class="b">✕ clear</a></div>` : ''}
  </div>
  <div class="row between mt" style="min-height:36px"><span class="small muted" id="count"></span>
    <div class="row" id="bulk" hidden><span class="small b" id="selN"></span>
      <button class="btn sm" data-bulk="in_progress">Mark in progress</button><button class="btn sm" data-bulk="resolved">Mark resolved</button>${app.can('issue:ignore') ? '<button class="btn sm" data-bulk="ignored">Ignore</button>' : ''}<button class="btn sm ghost" data-bulk="open">Reopen</button></div></div>
  <div class="tbl-wrap tall mt-s"><table class="tbl"><thead><tr><th style="width:30px"><input type="checkbox" id="all"></th><th>Severity</th><th>Issue</th><th>URL</th><th>Category</th><th>Type</th><th>Status</th><th>Assignee</th></tr></thead><tbody id="rows"><tr><td colspan="8" class="empty"><span class="spinner"></span></td></tr></tbody></table></div>`;

  for (const [k, v] of Object.entries(f)) { const i = el.querySelector(`[data-f="${k}"]`); if (i) i.value = v; }
  let rows = [];
  const selected = new Set();

  const load = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== ''));
    if (f.status === '') qs.set('status', '');
    rows = await api.get(`/api/audits/${a.id}/issues?${qs}`);
    history.replaceState(null, '', `#/issues?${new URLSearchParams(Object.entries(f).filter(([k, v]) => v !== '' || k === 'status'))}`);
    draw();
  };
  const draw = () => {
    el.querySelector('#count').textContent = `${rows.length} issue${rows.length === 1 ? '' : 's'} · ${rows.filter(r => r.severity === 'critical').length} critical`;
    el.querySelector('#rows').innerHTML = rows.length ? rows.map(r => `<tr class="click" data-id="${r.id}">
      <td><input type="checkbox" data-sel="${r.id}" ${selected.has(r.id) ? 'checked' : ''}></td>
      <td>${sevBadge(r.severity)}</td>
      <td><div class="b">${esc(r.title)}</div><div class="small muted">${esc(r.standard?.name || '')}</div></td>
      <td class="mono small" style="max-width:280px;word-break:break-all">${esc(short(r.url))}</td>
      <td class="small">${esc(cats[r.category]?.label || r.category)}</td>
      <td>${srcBadge(r.source)}</td><td>${statusBadge(r.status)}</td><td class="small">${esc(r.assignee || '—')}</td></tr>`).join('')
      : '<tr><td colspan="8"><div class="empty"><h3>No issues match these filters</h3>Try clearing a filter.</div></td></tr>';
    el.querySelector('#bulk').hidden = !selected.size;
    el.querySelector('#selN').textContent = `${selected.size} selected`;
  };

  el.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener(inp.tagName === 'INPUT' ? 'input' : 'change', debounce(() => { f[inp.dataset.f] = inp.value; load(); }, inp.tagName === 'INPUT' ? 300 : 0)));
  el.querySelector('#clearRule')?.addEventListener('click', (e) => { e.preventDefault(); f.rule = ''; e.target.parentElement.remove(); load(); });
  el.querySelector('#rows').addEventListener('click', (e) => {
    const cb = e.target.closest('[data-sel]');
    if (cb) { e.stopPropagation(); const id = Number(cb.dataset.sel); cb.checked ? selected.add(id) : selected.delete(id); draw(); return; }
    const tr = e.target.closest('tr[data-id]'); if (tr) app.go(`issues/${tr.dataset.id}`);
  });
  el.querySelector('#all').addEventListener('change', (e) => { selected.clear(); if (e.target.checked) rows.forEach(r => selected.add(r.id)); draw(); });
  el.querySelector('#bulk').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-bulk]'); if (!b) return;
    try { await api.post('/api/issues/bulk', { ids: [...selected], status: b.dataset.bulk }); toast(`${selected.size} issue(s) updated`); selected.clear(); await app.refreshAudit(); load(); }
    catch (err) { toast(err.message, true); }
  });
  load();
}
