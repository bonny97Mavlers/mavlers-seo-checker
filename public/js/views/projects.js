import { api } from '../api.js';
import { esc, fmtDate, readinessBadge, ring, host, toast } from '../ui.js';

export default async function render(el, params, app) {
  const projects = await api.get('/api/projects');
  el.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">Projects</span><h1>Website projects</h1><p>Each project keeps its URL, audit history, issues, readiness and reports.</p></div><a class="btn primary" href="#/audits/new">+ New project audit</a></div>
  ${projects.length ? `<div class="grid g3">${projects.map(p => `
    <div class="card" style="display:flex;flex-direction:column;gap:12px">
      <div class="row between" style="flex-wrap:nowrap;align-items:flex-start"><div style="min-width:0"><h3 class="trunc">${esc(p.name)}</h3><div class="small muted mono trunc">${esc(host(p.url))}</div></div>${p.latest ? ring(p.latest.score, 64, 7) : ''}</div>
      <div class="row">${p.running ? `<span class="badge info pulse">Audit running</span>` : p.latest ? readinessBadge(p.latest.readiness) : '<span class="badge grey">No completed audit</span>'}
        ${p.latest ? `<span class="small muted">${p.latest.counts?.critical ?? 0} critical · ${p.latest.counts?.warning ?? 0} warnings</span>` : ''}</div>
      <div class="tiny muted">${p.auditCount} audit${p.auditCount === 1 ? '' : 's'}${p.latest ? ` · last ${fmtDate(p.latest.finished_at)}` : ''}</div>
      <div class="row" style="margin-top:auto">
        ${p.latest ? `<a class="btn sm primary" href="#/audits/${p.latest.id}">Open dashboard</a>` : ''}
        ${p.running ? `<a class="btn sm" href="#/audits/${p.running.id}/crawl">View progress</a>` : `<a class="btn sm" href="#/audits/new?project=${p.id}">Run audit</a>`}
        <a class="btn sm ghost" href="#/history?project=${p.id}">History</a>
        ${app.can('projects:delete') ? `<button class="btn sm ghost" data-del="${p.id}" title="Delete project">✕</button>` : ''}
      </div>
    </div>`).join('')}</div>` : '<div class="card empty"><h3>No projects yet</h3><p>Projects are created automatically when you run an audit.</p><a class="btn primary" href="#/audits/new">Run an audit</a></div>'}`;
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this project and all its audits?')) return;
    await api.del(`/api/projects/${b.dataset.del}`); toast('Project deleted');
    if (app.project?.id === Number(b.dataset.del)) await app.setAudit(null);
    render(el, params, app);
  });
}
