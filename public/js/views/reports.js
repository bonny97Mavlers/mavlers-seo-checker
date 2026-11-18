import { api } from '../api.js';
import { esc, host, readinessBadge, fmtDate } from '../ui.js';

export const needsAudit = true;

export default async function (el, params, app) {
  const a = app.audit;
  const canReport = app.can('report');
  el.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">Reports · Audit #${a.id}</span><h1>Reports</h1><p>${esc(host(a.url))} · ${fmtDate(a.finished_at)} · ${Math.round(a.score)}/100 ${readinessBadge(a.readiness)}</p></div></div>
  <div class="grid g2">
    <div class="card"><span class="badge dark">Internal</span><h2 class="mt-s">Internal QA report</h2>
      <p class="muted small">For the Mavlers team: score, readiness, every critical issue and warning, page-level findings, technical/schema/crawlability details, recommendations and the manual checklist.</p>
      <div class="row mt"><a class="btn primary" ${canReport ? `href="${api.link(`/api/audits/${a.id}/report?type=internal`)}" target="_blank" rel="noopener"` : 'disabled'}>Open report</a><a class="btn" href="${api.link(`/api/audits/${a.id}/issues.csv`)}">Export issues (CSV)</a></div>
      <p class="tiny muted mt-s">Use “Save as PDF” in the report to export.</p></div>
    <div class="card"><span class="badge yellow">Client-friendly</span><h2 class="mt-s">Client SEO launch report</h2>
      <p class="muted small">Simplified for the client: overall status, SEO health by area, completed checks and key recommendations. No internal technical detail.</p>
      <div class="row mt"><a class="btn primary" ${canReport ? `href="${api.link(`/api/audits/${a.id}/report?type=client`)}" target="_blank" rel="noopener"` : 'disabled'}>Open report</a>
        <a class="btn" href="#/assistant?q=${encodeURIComponent('Write a client summary')}">Draft client email summary ✦</a></div></div>
  </div>
  <div class="card mt"><h3 class="mb">Quick summaries from the assistant</h3><div class="row">
    ${['Generate a final SEO QA summary', 'Create a developer fix checklist', 'Create a PM checklist', 'What are the 5 most important issues before launch?'].map(p => `<a class="btn sm" href="#/assistant?q=${encodeURIComponent(p)}">${esc(p)}</a>`).join('')}</div></div>`;
}
