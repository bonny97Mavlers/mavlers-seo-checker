import { api } from '../api.js';
import { esc, fmtDate, readinessBadge, host, toast } from '../ui.js';

export default async function (el, params, app) {
  const audits = await api.get('/api/audits');
  el.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">SEO Audits</span><h1>All audits</h1><p>Every crawl run across all projects.</p></div><a class="btn primary" href="#/audits/new">+ Run new audit</a></div>
  ${audits.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Project</th><th>Website</th><th>Status</th><th class="num">Score</th><th>Readiness</th><th class="num">Critical</th><th class="num">Warnings</th><th class="num">Pages</th><th>Started</th><th>By</th><th></th></tr></thead><tbody>
  ${audits.map(a => `<tr class="click" data-id="${a.id}" data-status="${a.status}"><td class="b">${a.id}</td><td>${esc(a.project_name)}</td><td class="mono small">${esc(host(a.url))}</td>
    <td>${a.status === 'complete' ? '<span class="badge ok">Complete</span>' : a.status === 'failed' ? `<span class="badge crit" title="${esc(a.error || '')}">Failed</span>` : `<span class="badge info">${esc(a.status)}</span>`}</td>
    <td class="num b">${a.score ?? '–'}</td><td>${a.status === 'complete' ? readinessBadge(a.readiness) : ''}</td><td class="num">${a.counts?.critical ?? '–'}</td><td class="num">${a.counts?.warning ?? '–'}</td><td class="num">${a.pages_scanned || '–'}</td>
    <td class="small">${fmtDate(a.started_at)}</td><td class="small muted">${esc(a.options?.startedBy || '')}</td>
    <td>${app.can('audit:run') ? `<button class="btn ghost sm" data-del="${a.id}" title="Delete audit">✕</button>` : ''}</td></tr>`).join('')}
  </tbody></table></div>` : '<div class="card empty"><h3>No audits yet</h3><a class="btn primary" href="#/audits/new">Run your first audit</a></div>'}`;
  el.querySelector('tbody')?.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); if (confirm(`Delete audit #${del.dataset.del}? This cannot be undone.`)) { await api.del(`/api/audits/${del.dataset.del}`); toast('Audit deleted'); if (Number(del.dataset.del) === app.auditId) await app.setAudit(null); app.go('audits'); location.reload(); } return; }
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    if (['queued', 'crawling', 'analysing'].includes(tr.dataset.status)) app.go(`audits/${tr.dataset.id}/crawl`);
    else app.go(`audits/${tr.dataset.id}`);
  });
}
