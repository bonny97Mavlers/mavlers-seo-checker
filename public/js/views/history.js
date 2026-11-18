import { api } from '../api.js';
import { esc, fmtDate, readinessBadge, lineChart, host, toast } from '../ui.js';

export default async function (el, params, app) {
  const projects = await api.get('/api/projects');
  if (!projects.length) { el.innerHTML = '<div class="card empty"><h3>No audits yet</h3><a class="btn primary" href="#/audits/new">Run your first audit</a></div>'; return; }
  const pid = Number(app.query().get('project')) || app.audit?.project_id || projects[0].id;
  const proj = await api.get(`/api/projects/${pid}`);
  const done = proj.audits.filter(a => a.status === 'complete');
  const asc = [...done].reverse();

  el.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">Audit history</span><h1>${esc(proj.name)}</h1><p class="mono small">${esc(proj.url)}</p></div>
    <div class="row"><select class="select" id="proj" style="width:auto">${projects.map(p => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <a class="btn primary" href="#/audits/new?project=${pid}">Re-run audit</a></div></div>
  ${asc.length ? `<div class="card"><div class="card-h"><h3>SEO score over time</h3><span class="small muted">${asc.length} completed audit${asc.length > 1 ? 's' : ''}</span></div>${lineChart(asc.map(a => ({ y: a.score, label: `Audit #${a.id}` })))}</div>` : ''}
  <div class="card mt" style="padding:0;overflow:hidden">
    <div class="row between" style="padding:14px 18px"><h3>Audits</h3><div class="row"><span class="small muted">Select two audits to compare</span><button class="btn primary sm" id="cmp" disabled>Compare selected</button></div></div>
    <div class="tbl-wrap" style="border:0;border-radius:0"><table class="tbl"><thead><tr><th></th><th>Audit</th><th>Date</th><th class="num">Score</th><th>Readiness</th><th class="num">Critical</th><th class="num">Warnings</th><th class="num">Standards met</th><th class="num">Pages</th><th>Scope</th><th>Standards</th><th></th></tr></thead><tbody>
    ${proj.audits.map((a, idx) => {
      const prev = proj.audits.slice(idx + 1).find(x => x.status === 'complete');
      const d = a.status === 'complete' && prev ? Math.round(a.score - prev.score) : null;
      return `<tr><td>${a.status === 'complete' ? `<input type="checkbox" data-cmp="${a.id}">` : ''}</td>
        <td class="b">#${a.id}</td><td class="small">${fmtDate(a.finished_at || a.started_at)}</td>
        <td class="num"><b>${a.score ?? '–'}</b>${d != null ? ` <span class="badge ${d >= 0 ? 'ok' : 'crit'}">${d >= 0 ? '+' : ''}${d}</span>` : ''}</td>
        <td>${a.status === 'complete' ? readinessBadge(a.readiness) : `<span class="badge ${a.status === 'failed' ? 'crit' : 'info'}">${esc(a.status)}</span>`}</td>
        <td class="num">${a.counts?.critical ?? '–'}</td><td class="num">${a.counts?.warning ?? '–'}</td><td class="num">${a.counts ? `${a.counts.passed}/${a.counts.standardsEvaluated}` : '–'}</td>
        <td class="num">${a.pages_scanned || '–'}</td><td class="small">${a.options?.maxPages ? `max ${a.options.maxPages}` : ''}</td><td class="small">v${a.standards_version ?? '–'}</td>
        <td>${a.status === 'complete' ? `<a class="btn sm" href="#/audits/${a.id}">Open</a>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div></div>`;

  el.querySelector('#proj').onchange = (e) => app.go(`history?project=${e.target.value}`);
  const sel = [];
  el.querySelector('tbody').addEventListener('change', e => {
    const cb = e.target.closest('[data-cmp]'); if (!cb) return;
    const id = Number(cb.dataset.cmp);
    if (cb.checked) { sel.push(id); if (sel.length > 2) { const drop = sel.shift(); el.querySelector(`[data-cmp="${drop}"]`).checked = false; } }
    else sel.splice(sel.indexOf(id), 1);
    el.querySelector('#cmp').disabled = sel.length !== 2;
  });
  el.querySelector('#cmp').onclick = () => app.go(`compare?a=${Math.min(...sel)}&b=${Math.max(...sel)}`);
  if (done.length >= 2 && !sel.length) { /* convenience: preselect latest two */
    const [n, o] = done; for (const id of [o.id, n.id]) { const cb = el.querySelector(`[data-cmp="${id}"]`); if (cb) { cb.checked = true; sel.push(id); } }
    el.querySelector('#cmp').disabled = false;
  }
}
