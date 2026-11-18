'use strict';
/** Printable, Mavlers-branded HTML reports (Internal QA + Client-friendly). Browser "Save as PDF" exports them. */
const { all, get, J } = require('./db');
const standardsSvc = require('./engine/standards');
const { checklistState } = require('./engine/analyse');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (u) => { try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return u; } };
const LABEL = { READY: 'Ready for client delivery', READY_WITH_WARNINGS: 'Ready with warnings', NOT_READY: 'Not ready' };
const COLOR = { READY: '#1f9d55', READY_WITH_WARNINGS: '#e8890c', NOT_READY: '#d64545' };

function layout(title, body) {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
@page{size:A4;margin:16mm 14mm}
*{box-sizing:border-box}body{font-family:Montserrat,Arial,sans-serif;color:#111;margin:0;font-size:11pt;line-height:1.5}
.wrap{max-width:900px;margin:0 auto;padding:28px}
.cover{background:#000;color:#fff;padding:28px 32px;border-radius:14px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px}
.logo{font-weight:800;font-size:26px;letter-spacing:-.5px}.logo span{color:#FFDB2D}.tag{font-size:10px;color:#bbb;letter-spacing:.4px}
h1{font-size:24px;margin:18px 0 4px}h2{font-size:15px;margin:26px 0 8px;padding-bottom:6px;border-bottom:3px solid #FFDB2D;display:inline-block}
.meta{color:#bbb;font-size:12px;text-align:right}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:18px}
.kpi{border:1px solid #e6e6e6;border-radius:10px;padding:12px}.kpi b{display:block;font-size:22px}.kpi small{color:#666;font-size:10px;text-transform:uppercase;letter-spacing:.5px}
.status{display:inline-block;padding:6px 12px;border-radius:999px;color:#fff;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
table{width:100%;border-collapse:collapse;font-size:10pt;margin-top:6px}th{background:#000;color:#fff;text-align:left;padding:7px 8px;font-weight:600}
td{border-bottom:1px solid #eee;padding:6px 8px;vertical-align:top}tr:nth-child(even) td{background:#fafafa}
.sev{font-weight:700;font-size:9pt;text-transform:uppercase}.critical{color:#d64545}.warning{color:#e8890c}.ok{color:#1f9d55}
.bar{height:8px;background:#eee;border-radius:4px;overflow:hidden}.bar i{display:block;height:100%;background:#FFDB2D}
.note{background:#fffbe6;border-left:4px solid #FFDB2D;padding:10px 12px;border-radius:6px;font-size:10pt}
.foot{margin-top:30px;color:#888;font-size:9pt;border-top:1px solid #eee;padding-top:10px}
.noprint{position:fixed;top:12px;right:12px}.noprint button{background:#FFDB2D;border:0;padding:10px 16px;border-radius:8px;font-weight:700;font-family:inherit;cursor:pointer}
@media print{.noprint{display:none}.wrap{padding:0}h2{break-after:avoid}tr{break-inside:avoid}}
</style></head><body><div class="noprint"><button onclick="window.print()">Save as PDF</button></div><div class="wrap">${body}</div></body></html>`;
}

async function load(auditId) {
  const a = await get('SELECT * FROM audits WHERE id = ?', auditId);
  if (!a || a.status !== 'complete') throw Object.assign(new Error('Audit not complete'), { status: 404 });
  const project = await get('SELECT * FROM projects WHERE id = ?', a.project_id);
  return { a: { ...a, site: J(a.site, {}), counts: J(a.counts, {}), cats: J(a.category_scores, {}) }, project };
}

function cover(a, project, kind) {
  return `<div class="cover"><div><div class="logo">mavlers<span>.</span></div><div class="tag">A brand of Uplers</div>
<h1 style="color:#fff">${kind}</h1><div style="color:#FFDB2D;font-weight:600">${esc(project.name)} · ${esc(a.site.startUrl)}</div></div>
<div class="meta">Audit #${a.id}<br>${esc(a.finished_at)} UTC<br>${a.pages_scanned} pages analysed<br>Standards v${a.standards_version}</div></div>`;
}

async function internalReport(auditId) {
  const { a, project } = await load(auditId);
  const issues = await all("SELECT * FROM issues WHERE audit_id = ? ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, category, rule_id", auditId);
  const open = issues.filter(i => ['open', 'in_progress'].includes(i.status));
  const stds = await standardsSvc.byId();
  const rr = await all('SELECT * FROM rule_results WHERE audit_id = ?', auditId);
  const pages = (await all("SELECT url, status_code, page_type, indexable, score, data FROM pages WHERE audit_id = ? AND page_type IS NOT NULL ORDER BY score ASC", auditId)).map(p => ({ ...p, d: J(p.data, {}) }));
  const cl = await checklistState(auditId);
  const byRule = {}; open.forEach(i => (byRule[i.rule_id] ||= []).push(i));
  const passed = rr.filter(r => !byRule[r.rule_id]);

  const body = `${cover(a, project, 'Internal SEO QA Report')}
<div class="kpis"><div class="kpi"><small>SEO health score</small><b>${a.score}/100</b></div>
<div class="kpi"><small>Launch readiness</small><span class="status" style="background:${COLOR[a.readiness]}">${LABEL[a.readiness]}</span><div style="font-size:11px;margin-top:4px">${a.readiness_pct}% ready</div></div>
<div class="kpi"><small>Open issues</small><b><span class="critical">${a.counts.critical}</span> / <span class="warning">${a.counts.warning}</span></b><small>critical / warnings</small></div>
<div class="kpi"><small>Standards met</small><b class="ok">${a.counts.passed}/${a.counts.standardsEvaluated}</b></div></div>

<h2>Category scores</h2>
<table><tr><th>Category</th><th style="width:90px">Weight</th><th style="width:90px">Score</th><th style="width:35%"></th></tr>
${Object.values(a.cats).map(c => `<tr><td>${esc(c.label)}</td><td>${c.weight}%</td><td>${c.score == null ? '–' : c.score + '%'}</td><td>${c.score == null ? '<small>Not evaluated</small>' : `<div class="bar"><i style="width:${c.score}%"></i></div>`}</td></tr>`).join('')}</table>

<h2>Critical issues</h2>${issueTable(open.filter(i => i.severity === 'critical'), stds)}
<h2>Warnings</h2>${issueTable(open.filter(i => i.severity === 'warning'), stds)}

<h2>Recommendations by standard</h2>
<table><tr><th>Standard</th><th>Affected</th><th>Recommended fix</th></tr>
${Object.entries(byRule).map(([r, list]) => `<tr><td><span class="sev ${list[0].severity}">${list[0].severity}</span><br>${esc(stds[r]?.name || r)}</td><td>${list.length}</td><td>${esc(stds[r]?.recommendation || '')}</td></tr>`).join('') || '<tr><td colspan="3">No open issues.</td></tr>'}</table>

<h2>Passed checks</h2>
<table><tr><th>Standard</th><th>Category</th><th>Checked</th></tr>${passed.map(r => `<tr><td class="ok">✓ ${esc(stds[r.rule_id]?.name || r.rule_id)}</td><td>${esc(a.cats[r.category]?.label || r.category)}</td><td>${r.evaluated}</td></tr>`).join('')}</table>

<h2>Page-level findings</h2>
<table><tr><th>URL</th><th>Type</th><th>Status</th><th>Indexable</th><th>Title</th><th>Meta</th><th>H1</th><th>Words</th><th>Score</th></tr>
${pages.map(p => { const d = p.d.page || {}; return `<tr><td>${esc(short(p.url))}</td><td>${esc(p.page_type)}</td><td>${p.status_code}</td><td>${p.indexable ? 'Yes' : 'No'}</td><td>${d.titleLength ?? '–'}</td><td>${d.metaLength ?? '–'}</td><td>${(d.h1s || []).length}</td><td>${d.wordCount ?? '–'}</td><td>${p.score ?? '–'}</td></tr>`; }).join('')}</table>

<h2>Technical & crawlability</h2>
<table>
<tr><td>HTTPS</td><td>${a.site.https ? '✓ Yes' : '✗ No'}</td></tr>
<tr><td>robots.txt</td><td>${a.site.robots?.exists ? '✓ Present' : '✗ Missing'}${a.site.robots?.blocksAll ? ' — blocks entire site' : ''}</td></tr>
<tr><td>XML sitemap</td><td>${a.site.sitemap?.found?.length ? `✓ ${a.site.sitemap.found.map(f => esc(short(f.url))).join(', ')} (${a.site.sitemap.urlCount} URLs)` : '✗ Not found'}</td></tr>
<tr><td>CMS / SEO plugin</td><td>${esc(a.site.cms || 'Not detected')} ${a.site.seoPlugin ? '/ ' + esc(a.site.seoPlugin) : ''}</td></tr>
<tr><td>Tracking detected</td><td>${esc([...(a.site.tracking?.ga4 || []), ...(a.site.tracking?.gtm || [])].join(', ') || 'None')}</td></tr>
<tr><td>Core Web Vitals</td><td>${a.site.cwv && !a.site.cwv.error ? `LCP ${a.site.cwv.lcp != null ? (a.site.cwv.lcp / 1000).toFixed(1) + 's' : '–'} · INP ${a.site.cwv.inp ?? '–'}ms · CLS ${a.site.cwv.cls?.toFixed?.(2) ?? '–'} (${esc(a.site.cwv.source)})` : 'Not measured — manual verification required (PageSpeed Insights)'}</td></tr>
</table>

<h2>Pre-delivery checklist</h2>
<table><tr><th>Item</th><th>Type</th><th>Status</th></tr>${cl.map(c => `<tr><td>${esc(c.label)}${c.note ? `<br><small>${esc(c.note)}</small>` : ''}</td><td>${c.type === 'auto' ? 'Automatically verified' : 'Manual verification'}</td><td class="${c.done ? 'ok' : 'warning'}">${c.done ? '✓ Done' : '☐ Pending'}${c.checkedBy ? ` <small>(${esc(c.checkedBy)})</small>` : ''}</td></tr>`).join('')}</table>
<div class="foot">Generated by the Mavlers SEO Pre-Launch Checker. Automatically verified findings come from crawling the live HTML; heuristic checks and AI suggestions require human review; manual items must be confirmed in Google Search Console / GA4.</div>`;
  return layout(`SEO QA Report — ${project.name}`, body);
}

function issueTable(list, stds) {
  if (!list.length) return '<p class="ok">✓ None</p>';
  return `<table><tr><th style="width:30%">URL</th><th>Issue</th><th style="width:28%">Current</th><th style="width:90px">Status</th></tr>${list.slice(0, 400).map(i => `<tr><td>${esc(short(i.url))}</td><td><b>${esc(i.title)}</b><br><small>${esc(stds[i.rule_id]?.name || '')}</small></td><td><small>${esc((i.current_value || '').slice(0, 180))}</small></td><td>${esc(i.status.replace('_', ' '))}${i.assignee ? `<br><small>${esc(i.assignee)}</small>` : ''}</td></tr>`).join('')}</table>${list.length > 400 ? `<p>…and ${list.length - 400} more.</p>` : ''}`;
}

async function clientReport(auditId) {
  const { a, project } = await load(auditId);
  const rr = await all('SELECT * FROM rule_results WHERE audit_id = ?', auditId);
  const open = await all("SELECT rule_id, severity FROM issues WHERE audit_id = ? AND status IN ('open','in_progress')", auditId);
  const stds = await standardsSvc.byId();
  const failing = new Set(open.map(i => i.rule_id));
  const done = rr.filter(r => !failing.has(r.rule_id)).map(r => stds[r.rule_id]?.name).filter(Boolean);
  const recs = [...new Set(open.map(i => i.rule_id))].map(r => stds[r]).filter(Boolean).sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'critical' ? -1 : 1)).slice(0, 8);
  const health = a.score >= 90 ? 'Excellent' : a.score >= 75 ? 'Good' : a.score >= 50 ? 'Needs improvement' : 'Poor';
  const body = `${cover(a, project, 'SEO Launch Report')}
<div class="kpis" style="grid-template-columns:repeat(3,1fr)"><div class="kpi"><small>Overall SEO health</small><b>${a.score}/100</b><small>${health}</small></div>
<div class="kpi"><small>Launch status</small><span class="status" style="background:${COLOR[a.readiness]}">${LABEL[a.readiness]}</span></div>
<div class="kpi"><small>Checks completed</small><b class="ok">${done.length}</b><small>standards met</small></div></div>
<h2>Summary</h2><p>We reviewed <b>${a.pages_scanned} pages</b> of ${esc(a.site.startUrl)} against the Mavlers on-page SEO build standard, covering titles and meta descriptions, headings, URL structure, indexing and crawlability, structured data, images, technical basics and AI-search readiness.</p>
<h2>SEO health by area</h2><table><tr><th>Area</th><th style="width:90px">Score</th><th style="width:45%"></th></tr>${Object.values(a.cats).filter(c => c.score != null).map(c => `<tr><td>${esc(c.label)}</td><td>${c.score}%</td><td><div class="bar"><i style="width:${c.score}%"></i></div></td></tr>`).join('')}</table>
<h2>Completed checks</h2><ul style="columns:2;font-size:10pt;list-style:none;padding-left:0">${done.map(n => `<li>✓ ${esc(n)}</li>`).join('')}</ul>
<h2>Key recommendations</h2>${recs.length ? `<ol>${recs.map(s => `<li><b>${esc(s.name)}</b> — ${esc(s.recommendation)}</li>`).join('')}</ol>` : '<p class="ok">No outstanding recommendations.</p>'}
<div class="note"><b>Next steps after launch:</b> verify the site in Google Search Console, submit the XML sitemap, and confirm Google Analytics 4 is recording visits and key conversions.</div>
<div class="foot">Prepared by Mavlers · A brand of Uplers</div>`;
  return layout(`SEO Launch Report — ${project.name}`, body);
}

async function issuesCsv(auditId) {
  const rows = await all('SELECT * FROM issues WHERE audit_id = ? ORDER BY severity, category', auditId);
  const stds = await standardsSvc.byId();
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['id', 'severity', 'category', 'standard', 'url', 'issue', 'current', 'recommendation', 'status', 'assignee', 'created', 'resolved'];
  return [head.join(','), ...rows.map(r => [r.id, r.severity, r.category, stds[r.rule_id]?.name || r.rule_id, r.url, r.title, r.current_value, stds[r.rule_id]?.recommendation, r.status, r.assignee, r.created_at, r.resolved_at].map(q).join(','))].join('\n');
}

module.exports = { internalReport, clientReport, issuesCsv };
