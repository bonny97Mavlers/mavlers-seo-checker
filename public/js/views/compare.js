import { api } from '../api.js';
import { esc, short, fmtDate, readinessBadge, sevBadge, plural } from '../ui.js';

export default async function (el, params, app) {
  const q = app.query();
  const c = await api.get(`/api/compare?a=${q.get('a')}&b=${q.get('b')}`);
  const d = c.scoreDelta;
  const critResolved = c.resolved.filter(i => i.severity === 'critical').length;
  const list = (items, empty) => items.length ? `<div class="tbl-wrap" style="max-height:420px"><table class="tbl"><thead><tr><th>Severity</th><th>Issue</th><th>URL</th></tr></thead><tbody>${items.map(i => `<tr class="click" data-id="${i.id}"><td>${sevBadge(i.severity)}</td><td><b>${esc(i.title)}</b><div class="small muted">${esc(i.standard || '')}</div></td><td class="mono small">${esc(i.path)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty" style="padding:24px">${empty}</div>`;

  el.innerHTML = `
  <a href="#/history" class="small b">← Audit history</a>
  <div class="page-head mt-s"><div><span class="eyebrow">Audit comparison</span><h1>SEO improvement</h1><p>Audit #${c.older.id} (${fmtDate(c.older.date)}) → Audit #${c.newer.id} (${fmtDate(c.newer.date)})</p></div></div>
  ${c.older.standardsVersion !== c.newer.standardsVersion ? `<div class="note mb">Standards changed between these audits (v${c.older.standardsVersion} → v${c.newer.standardsVersion}); some differences may come from updated rules rather than site changes.</div>` : ''}
  ${new URL(c.older.url).host !== new URL(c.newer.url).host ? `<div class="note info mb">Comparing different hosts (${esc(new URL(c.older.url).host)} → ${esc(new URL(c.newer.url).host)}) — issues are matched by URL path, so staging-vs-live comparisons work.</div>` : ''}
  <div class="grid g4">
    <div class="kpi"><span class="l">Previous</span><span class="n">${c.older.score}<span style="font-size:15px;color:var(--m-muted)"> / 100</span></span>${readinessBadge(c.older.readiness)}</div>
    <div class="kpi"><span class="l">Current</span><span class="n">${c.newer.score}<span style="font-size:15px;color:var(--m-muted)"> / 100</span></span>${readinessBadge(c.newer.readiness)}</div>
    <div class="kpi ${d >= 0 ? 'ok' : 'crit'}"><span class="l">SEO score</span><span class="n">${d >= 0 ? '+' : ''}${d}</span><span class="small muted">${plural(c.resolved.length, 'issue')} resolved${critResolved ? ` (${critResolved} critical)` : ''}</span></div>
    <div class="kpi ${c.checksPassedDelta >= 0 ? 'ok' : 'crit'}"><span class="l">Checks passed</span><span class="n">${c.checksPassedDelta >= 0 ? '+' : ''}${c.checksPassedDelta}</span><span class="small muted">${plural(c.added.length, 'new issue')}</span></div>
  </div>
  <div class="card mt"><h3 class="mb">Score changes by category</h3>
    <table class="tbl"><thead><tr><th>Category</th><th class="num">Before</th><th class="num">After</th><th class="num">Change</th></tr></thead><tbody>
    ${c.categories.map(x => { const ch = x.before != null && x.after != null ? x.after - x.before : null; return `<tr><td>${esc(x.label)}</td><td class="num">${x.before ?? '–'}</td><td class="num b">${x.after ?? '–'}</td><td class="num">${ch == null ? '–' : `<span class="badge ${ch > 0 ? 'ok' : ch < 0 ? 'crit' : 'grey'}">${ch > 0 ? '+' : ''}${ch}</span>`}</td></tr>`; }).join('')}
    </tbody></table></div>
  <div class="card mt"><div class="tabs" id="tabs"><button class="on" data-t="resolved">Resolved issues (${c.resolved.length})</button><button data-t="added">New issues (${c.added.length})</button><button data-t="remaining">Remaining issues (${c.remaining.length})</button></div><div id="tab"></div></div>`;

  const panes = { resolved: list(c.resolved, 'No issues were resolved.'), added: list(c.added, '✓ No new issues introduced.'), remaining: list(c.remaining, '✓ No issues carried over.') };
  const show = (t) => { el.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); el.querySelector('#tab').innerHTML = panes[t]; };
  el.querySelector('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.t); };
  el.querySelector('#tab').addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr) app.go(`issues/${tr.dataset.id}`); });
  show('resolved');
}
