import { api } from '../api.js';
import { esc, short, scoreColor, debounce } from '../ui.js';

export const needsAudit = true;

export default async function (el, params, app) {
  const a = app.audit;
  const [all, stdRes] = await Promise.all([api.get(`/api/audits/${a.id}/pages`), api.get('/api/standards')]);
  const T = Object.fromEntries(stdRes.standards.map(s => [s.id, s.threshold || {}]));
  const types = [...new Set(all.map(p => p.type).filter(Boolean))];
  const st = { q: '', type: '', view: 'html', sort: 'score' };
  const t = (n, lo, hi) => n == null ? '<span class="muted">–</span>' : `<span style="color:${n < lo || n > hi ? 'var(--warn)' : 'var(--ok)'};font-weight:700">${n}</span>`;

  el.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">Pages · Audit #${a.id}</span><h1>Page analysis</h1><p>${all.filter(p => p.type).length} HTML pages analysed · ${all.filter(p => !p.type).length} redirects, errors and other URLs.</p></div></div>
  <div class="card row" style="padding:14px">
    <input class="input" id="q" placeholder="Search URL, title or H1…" style="max-width:340px">
    <select class="select" id="type" style="width:auto"><option value="">All page types</option>${types.map(x => `<option>${x}</option>`).join('')}</select>
    <select class="select" id="view" style="width:auto"><option value="html">HTML pages</option><option value="other">Redirects / errors</option><option value="all">All URLs</option></select>
    <select class="select" id="sort" style="width:auto"><option value="score">Lowest score first</option><option value="issues">Most issues first</option><option value="url">URL A–Z</option><option value="inlinks">Fewest inlinks</option></select>
  </div>
  <div class="tbl-wrap tall mt"><table class="tbl"><thead><tr><th>URL</th><th>Status</th><th>Type</th><th>Indexable</th><th class="num">Score</th><th class="num">Title</th><th class="num">Meta</th><th class="num">H1</th><th class="num">Words</th><th class="num">In / Out</th><th class="num">Alt</th><th>Schema</th><th>Issues</th></tr></thead><tbody id="rows"></tbody></table></div>`;

  const draw = () => {
    let rows = all.filter(p => st.view === 'all' || (st.view === 'html' ? p.type : !p.type));
    if (st.type) rows = rows.filter(p => p.type === st.type);
    if (st.q) { const s = st.q.toLowerCase(); rows = rows.filter(p => `${p.url} ${p.title || ''} ${p.h1 || ''}`.toLowerCase().includes(s)); }
    rows.sort((x, y) => st.sort === 'url' ? x.url.localeCompare(y.url) : st.sort === 'issues' ? (y.issues.critical * 10 + y.issues.warning) - (x.issues.critical * 10 + x.issues.warning) : st.sort === 'inlinks' ? x.inlinks - y.inlinks : (x.score ?? 101) - (y.score ?? 101));
    el.querySelector('#rows').innerHTML = rows.map(p => `<tr class="click" data-id="${p.id}">
      <td style="max-width:300px"><div class="mono small b" style="word-break:break-all">${esc(short(p.url))}</div><div class="small muted trunc">${esc(p.title || (p.redirectOnly ? '→ ' + short(p.finalUrl) : p.error || ''))}</div></td>
      <td><span class="badge ${p.status >= 200 && p.status < 300 ? 'ok' : p.status >= 300 && p.status < 400 ? 'warn' : 'crit'}">${p.status || 'ERR'}</span></td>
      <td class="small">${esc(p.type || (p.redirectOnly ? 'redirect' : '—'))}</td>
      <td>${p.type ? (p.indexable ? '<span class="badge ok">Yes</span>' : `<span class="badge grey">${p.noindex ? 'noindex' : 'No'}</span>`) : ''}</td>
      <td class="num b" style="color:${scoreColor(p.score)}">${p.score ?? '–'}</td>
      <td class="num">${p.type ? t(p.titleLength, T['title-length'].min, T['title-length'].max) : ''}</td><td class="num">${p.type ? t(p.metaLength || 0, T['meta-length'].min, T['meta-length'].max) : ''}</td>
      <td class="num">${p.type ? `<span style="color:${p.h1Count === 1 ? 'var(--ok)' : 'var(--crit)'};font-weight:700">${p.h1Count}</span>` : ''}</td>
      <td class="num">${p.words ?? ''}</td><td class="num">${p.type ? `${p.inlinks} / ${p.outlinks}` : ''}</td>
      <td class="num">${p.images ? `${p.images - p.imagesNoAlt}/${p.images}` : (p.type ? '–' : '')}</td>
      <td class="small">${esc((p.schema || []).slice(0, 3).join(', '))}</td>
      <td>${p.issues.critical ? `<span class="badge crit">${p.issues.critical}</span> ` : ''}${p.issues.warning ? `<span class="badge warn">${p.issues.warning}</span>` : ''}${!p.issues.critical && !p.issues.warning && p.type ? '<span class="badge ok">✓</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="13" class="empty">No pages match.</td></tr>';
  };
  el.querySelector('#q').addEventListener('input', debounce(e => { st.q = e.target.value; draw(); }));
  ['type', 'view', 'sort'].forEach(k => el.querySelector('#' + k).addEventListener('change', e => { st[k] = e.target.value; draw(); }));
  el.querySelector('#rows').addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr) app.go(`pages/${tr.dataset.id}`); });
  draw();
}
