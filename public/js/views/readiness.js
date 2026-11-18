import { api } from '../api.js';
import { esc, short, srcBadge, toast, plural, fmtDate } from '../ui.js';
import { readinessBanner } from './dashboard.js';

export const needsAudit = true;

export default async function render(el, params, app) {
  await app.refreshAudit();
  const a = app.audit;
  const [issues, checklist, stdRes] = await Promise.all([api.get(`/api/audits/${a.id}/issues?status=unresolved`), api.get(`/api/audits/${a.id}/checklist`), api.get('/api/standards')]);
  const stds = Object.fromEntries(stdRes.standards.map(s => [s.id, s]));
  const group = (sev) => { const g = {}; issues.filter(i => i.severity === sev).forEach(i => (g[i.rule_id] ||= []).push(i)); return Object.entries(g).sort((x, y) => y[1].length - x[1].length); };
  const crit = group('critical'), warn = group('warning');
  const failing = new Set(issues.map(i => i.rule_id));
  const passed = (a.rules || []).filter(r => !failing.has(r.rule_id));
  const c = a.counts;
  const canCheck = app.can('checklist');

  const groupHtml = (list, sev) => list.map(([rule, items]) => `<details class="card flat" style="padding:12px 16px;margin-bottom:8px"><summary class="row between" style="cursor:pointer;list-style:none"><span class="row"><span class="sev-dot ${sev}"></span><b>${esc(stds[rule]?.name || rule)}</b></span><span class="badge ${sev === 'critical' ? 'crit' : 'warn'}">${items.length}</span></summary>
    <div class="small muted mt-s">${esc(stds[rule]?.recommendation || '')}</div>
    <ul class="small" style="margin:8px 0 0;padding-left:18px">${items.slice(0, 15).map(i => `<li><a href="#/issues/${i.id}" class="mono">${esc(short(i.url))}</a> — ${esc(i.title)}</li>`).join('')}${items.length > 15 ? `<li class="muted">+${items.length - 15} more</li>` : ''}</ul></details>`).join('');

  el.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">Launch readiness · Audit #${a.id}</span><h1>Is this website ready for client delivery?</h1></div></div>
  ${readinessBanner(a, { link: false })}
  <div class="grid g4 mt">
    <div class="kpi crit"><span class="l">Critical</span><span class="n">${c.critical}</span></div>
    <div class="kpi warn"><span class="l">Warnings</span><span class="n">${c.warning}</span></div>
    <div class="kpi ok"><span class="l">Standards met</span><span class="n">${c.passed}/${c.standardsEvaluated}</span></div>
    <div class="kpi"><span class="l">Manual items pending</span><span class="n">${c.manualPending}</span></div>
  </div>
  ${c.resolvedPending ? `<div class="note mt">${plural(c.resolvedPending, 'issue is', 'issues are')} marked <b>resolved</b> but not yet verified by a crawl. <a href="#/audits/new?project=${a.project_id}" class="b">Re-run the audit</a> to confirm the fixes.</div>` : ''}
  ${c.ignored ? `<div class="note info mt">${plural(c.ignored, 'issue has', 'issues have')} been <b>ignored</b> and no longer affect readiness.</div>` : ''}

  <div class="grid mt" style="grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)">
    <div>
      <h2 class="mb">${a.readiness === 'NOT_READY' ? 'Why this website is not ready' : a.readiness === 'READY' ? 'Why this website is ready' : 'What still needs attention'}</h2>
      ${crit.length ? `<h3 class="mb" style="color:var(--crit)">Blocking — critical issues (${c.critical})</h3>${groupHtml(crit, 'critical')}` : '<div class="note mb" style="background:var(--ok-bg);border-color:var(--ok)">✓ No critical issues remain — nothing is blocking delivery.</div>'}
      ${warn.length ? `<h3 class="mb mt" style="color:#b86a00">Recommended improvements — warnings (${c.warning})</h3>${groupHtml(warn, 'warning')}` : ''}
    </div>
    <div>
      <div class="card"><div class="card-h"><h3>Pre-delivery checklist</h3></div>
        <div class="stack" id="cl">${checklist.map(ci => `
          <label class="check" style="align-items:center">
            <input type="checkbox" data-key="${ci.key}" ${ci.done ? 'checked' : ''} ${(!canCheck || (ci.type === 'auto' && ci.autoState === 'pass')) ? 'disabled' : ''}>
            <span style="flex:1"><b>${esc(ci.label)}</b>
              <span class="row" style="gap:6px;margin-top:4px">${ci.type === 'auto' ? srcBadge('auto') + (ci.autoState === 'pass' ? '<span class="badge ok">Passed</span>' : '<span class="badge warn">Open issues</span>') : srcBadge('manual')}
              ${ci.checkedBy && ci.manualChecked ? `<span class="tiny muted">✓ ${esc(ci.checkedBy)} · ${fmtDate(ci.checkedAt)}</span>` : ''}</span>
              ${ci.note ? `<span class="tiny muted" style="display:block;margin-top:4px">${esc(ci.note)}</span>` : ''}
              ${ci.type === 'auto' && ci.autoState === 'fail' ? '<span class="tiny muted" style="display:block">Tick to confirm manually if the open issues are accepted.</span>' : ''}
            </span>
          </label>`).join('')}</div>
        ${canCheck ? '' : '<p class="small muted mt-s">Only Project Managers and Admins can complete the checklist.</p>'}
      </div>
      <div class="card mt" id="passed"><div class="card-h"><h3><span class="sev-dot ok"></span> Passed standards (${passed.length})</h3></div>
        <ul class="small" style="margin:0;padding-left:0;list-style:none;columns:1">${passed.map(r => `<li style="padding:4px 0;border-bottom:1px solid #f3f3f3">✓ ${esc(stds[r.rule_id]?.name || r.rule_id)} <span class="muted">· ${r.evaluated} checked</span></li>`).join('')}</ul>
      </div>
    </div>
  </div>`;

  el.querySelector('#cl').addEventListener('change', async (e) => {
    const cb = e.target.closest('input[data-key]'); if (!cb) return;
    try { await api.put(`/api/audits/${a.id}/checklist/${cb.dataset.key}`, { checked: cb.checked }); toast(cb.checked ? 'Confirmed' : 'Unchecked'); render(el, params, app); }
    catch (err) { toast(err.message, true); cb.checked = !cb.checked; }
  });
  if (location.hash.endsWith('#passed')) el.querySelector('#passed').scrollIntoView();
}
