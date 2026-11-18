import { api } from '../api.js';
import { esc, short, ring, READINESS, healthLabel, plural, fmtDate, barCls, srcBadge, host } from '../ui.js';

export const needsAudit = true;

export function readinessWhy(a) {
  const c = a.counts || {};
  if (a.readiness === 'NOT_READY') return `${plural(c.critical, 'critical issue')} must be fixed before this site can be delivered.`;
  if (a.readiness === 'READY_WITH_WARNINGS') return `No blocking issues. ${c.warning ? plural(c.warning, 'warning') + ' open' : ''}${c.warning && c.manualPending ? ' and ' : ''}${c.manualPending ? plural(c.manualPending, 'checklist item') + ' awaiting manual confirmation' : ''}.`;
  return 'No critical issues or warnings remain and the pre-delivery checklist is complete.';
}

export function readinessBanner(a, { link = true } = {}) {
  const R = READINESS[a.readiness];
  return `<div class="readiness ${a.readiness}">
    <div class="ico">${R.icon}</div>
    <div style="min-width:0"><span class="eyebrow">Launch readiness</span><h2>${R.label}</h2><div class="small" style="margin-top:4px">${esc(readinessWhy(a))}</div>
      ${link ? '<a class="small b" href="#/readiness" style="display:inline-block;margin-top:6px">See why →</a>' : ''}</div>
    <div class="pct"><b>${a.readiness_pct ?? '–'}%</b><div class="tiny muted b">READINESS</div></div>
  </div>`;
}

export default async function (el, params, app) {
  await app.refreshAudit();
  const a = app.audit;
  const [issues, stdRes] = await Promise.all([api.get(`/api/audits/${a.id}/issues?status=unresolved`), api.get('/api/standards')]);
  const stds = Object.fromEntries(stdRes.standards.map(s => [s.id, s]));
  const c = a.counts || {};
  const crit = issues.filter(i => i.severity === 'critical');
  const delta = a.previous ? Math.round(a.score - a.previous.score) : null;
  const totalOpen = c.critical + c.warning;

  // recommended actions: group open issues by standard, critical first, widest impact first
  const groups = {};
  for (const i of issues) (groups[i.rule_id] ||= { rule: i.rule_id, sev: i.severity, n: 0, cat: i.category }).n++;
  const actions = Object.values(groups).sort((x, y) => (x.sev === y.sev ? y.n - x.n : x.sev === 'critical' ? -1 : 1)).slice(0, 6);
  const s = a.site || {};

  el.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">Dashboard · Audit #${a.id} · ${fmtDate(a.finished_at)}</span><h1>${esc(host(a.url))}</h1><p>${plural(a.pages_scanned, 'page')} analysed against Mavlers SEO standards v${a.standards_version}.</p></div>
    <div class="row"><a class="btn" href="#/reports">Reports</a><a class="btn primary" href="#/audits/new?project=${a.project_id}">Re-run audit</a></div></div>

  <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1.5fr)">
    <div class="card row" style="gap:22px;flex-wrap:nowrap">
      ${ring(a.score)}
      <div><span class="eyebrow">SEO health score</span>
        <h2 style="font-size:20px;margin-top:4px">${healthLabel(a.score).toUpperCase()} — ${totalOpen ? plural(totalOpen, 'issue') + ' require attention' : 'no open issues'}</h2>
        ${delta != null ? `<div class="mt-s small"><span class="badge ${delta >= 0 ? 'ok' : 'crit'}">${delta >= 0 ? '+' : ''}${delta}</span> vs audit #${a.previous.id} (${a.previous.score}/100)</div>` : '<div class="mt-s small muted">First audit for this project.</div>'}
        ${c.resolvedPending ? `<div class="mt-s small muted">${plural(c.resolvedPending, 'issue')} marked resolved — re-run to verify.</div>` : ''}
      </div>
    </div>
    ${readinessBanner(a)}
  </div>

  <div class="grid g3 mt">
    <a class="kpi crit" href="#/issues?severity=critical&status=unresolved"><span class="l"><span class="sev-dot critical"></span>Critical</span><span class="n">${c.critical}</span><span class="small muted">Normally block delivery</span></a>
    <a class="kpi warn" href="#/issues?severity=warning&status=unresolved"><span class="l"><span class="sev-dot warning"></span>Warnings</span><span class="n">${c.warning}</span><span class="small muted">Should ideally be resolved</span></a>
    <a class="kpi ok" href="#/readiness#passed"><span class="l"><span class="sev-dot ok"></span>Passed</span><span class="n">${c.passed}<span style="font-size:16px;color:var(--m-muted)">/${c.standardsEvaluated}</span></span><span class="small muted">Mavlers standards met</span></a>
  </div>

  <div class="grid g2 mt">
    <div class="card"><div class="card-h"><h3><span class="sev-dot critical"></span> Critical issues</h3><a class="small b" href="#/issues?severity=critical&status=unresolved">View all →</a></div>
      ${crit.length ? crit.slice(0, 8).map(i => `<a class="list-issue" href="#/issues/${i.id}"><span class="sev-dot critical" style="margin-top:6px"></span><div style="min-width:0"><div class="b">${esc(i.title)}</div><div class="small muted trunc mono">${esc(short(i.url))}</div></div></a>`).join('')
    + (crit.length > 8 ? `<div class="small muted mt-s">+${crit.length - 8} more</div>` : '') : '<div class="empty" style="padding:24px">✓ No critical issues. Nothing is blocking delivery.</div>'}
    </div>
    <div class="card"><div class="card-h"><h3>Recommended actions</h3><a class="small b" href="#/assistant?q=${encodeURIComponent('Create a developer fix checklist')}">Developer checklist →</a></div>
      ${actions.length ? `<ol style="margin:0;padding-left:18px">${actions.map(g => `<li style="margin-bottom:10px"><a href="#/issues?rule=${g.rule}&status=unresolved" class="b" style="text-decoration:none">${esc(stds[g.rule]?.name || g.rule)}</a> <span class="badge ${g.sev === 'critical' ? 'crit' : 'warn'}">${g.n}</span><div class="small muted">${esc(stds[g.rule]?.recommendation || '')}</div></li>`).join('')}</ol>` : '<div class="empty" style="padding:24px">Nothing to action.</div>'}
    </div>
  </div>

  <div class="card mt"><div class="card-h"><h3>Category scores</h3><span class="small muted">Weighted · click a category to see its issues</span></div>
    <div class="grid g4">${Object.entries(a.category_scores).map(([k, v]) => `<a class="cat" href="#/issues?category=${k}&status=unresolved"><div class="top"><span class="small b">${esc(v.label)}</span><b>${v.score == null ? '–' : v.score + '%'}</b></div><div class="bar ${barCls(v.score)}"><i style="width:${v.score ?? 0}%"></i></div><div class="tiny muted mt-s">Weight ${v.weight}%${v.score == null ? ' · not evaluated' : ` · ${v.failedRules || 0}/${v.rules} standards failing`}</div></a>`).join('')}</div>
  </div>

  <div class="grid g2 mt">
    <div class="card"><div class="card-h"><h3>Site overview</h3>${srcBadge('auto')}</div>
      <dl class="kv">
        <dt>Platform</dt><dd>${esc(s.cms || 'Not detected')}${s.seoPlugin ? ` · ${esc(s.seoPlugin)}` : ''}</dd>
        <dt>HTTPS</dt><dd>${s.https ? '✓ Enabled' : '✕ Not enabled'}</dd>
        <dt>robots.txt</dt><dd>${s.robots?.exists ? '✓ Present' : '✕ Missing'}${s.robots?.blocksAll ? ' — <b style="color:var(--crit)">blocks all crawling</b>' : ''}</dd>
        <dt>XML sitemap</dt><dd>${s.sitemap?.found?.length ? `✓ ${s.sitemap.urlCount} URLs` : s.options?.sitemap ? '✕ Not found' : 'Not checked'}</dd>
        <dt>Tracking detected</dt><dd>${[...(s.tracking?.ga4 || []), ...(s.tracking?.gtm || [])].map(esc).join(', ') || 'None'}</dd>
        <dt>Crawl scope</dt><dd>${a.pages_scanned} of max ${s.options?.maxPages} pages${s.timeBudgetReached ? ` · <span class="badge warn">time limit reached — ${s.uncrawledQueued} URLs not crawled</span>` : s.crawlLimitReached ? ` · <span class="badge warn">limit reached — ${s.uncrawledQueued} URLs not crawled</span>` : ''}</dd>
        ${s.stagingHost ? `<dt>Environment</dt><dd><span class="badge warn">Staging hostname</span></dd>` : ''}
      </dl>
    </div>
    <div class="card"><div class="card-h"><h3>Needs manual verification</h3>${srcBadge('manual')}</div>
      <p class="small muted" style="margin-top:0">These can't be confirmed by crawling alone — confirm them on the Launch Readiness checklist.</p>
      <ul class="small" style="padding-left:18px;margin:0">
        <li>Google Search Console verified ${s.tracking?.gscMeta ? '<span class="muted">(verification meta tag found)</span>' : ''}</li>
        <li>Sitemap submitted in Search Console</li>
        <li>GA4 receiving data + basic events/conversions configured</li>
        <li>Core Web Vitals baseline (LCP / INP / CLS) ${s.cwv && !s.cwv.error ? `<span class="muted">— measured: LCP ${s.cwv.lcp != null ? (s.cwv.lcp / 1000).toFixed(1) + 's' : '–'}, CLS ${s.cwv.cls?.toFixed?.(2) ?? '–'}</span>` : '<span class="muted">— connect PageSpeed Insights to automate</span>'}</li>
      </ul>
      <a class="btn sm mt" href="#/readiness">Open checklist</a>
    </div>
  </div>`;
}
