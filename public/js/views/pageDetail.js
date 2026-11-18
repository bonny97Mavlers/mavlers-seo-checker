import { api } from '../api.js';
import { esc, short, ring, sevBadge, srcBadge, icons } from '../ui.js';

export default async function (el, [id], app) {
  const [p, stdRes] = await Promise.all([api.get(`/api/pages/${id}`), api.get('/api/standards')]);
  const T = Object.fromEntries(stdRes.standards.map(s => [s.id, s.threshold || {}]));
  const d = p.data || {}; const pg = d.page;
  const ok = (cond, warnTxt) => cond ? '🟢' : (warnTxt === 'crit' ? '🔴' : '🟠');
  const issuesHere = p.issues.filter(i => !i.linkedFromHere && ['open', 'in_progress'].includes(i.status));
  const linkedIssues = p.issues.filter(i => i.linkedFromHere && ['open', 'in_progress'].includes(i.status));

  if (!pg) {
    el.innerHTML = `<a href="javascript:history.back()" class="small b">← Back</a><div class="page-head mt"><div><span class="eyebrow">URL</span><h1 class="mono" style="font-size:20px;word-break:break-all">${esc(p.url)}</h1></div></div>
    <div class="card"><dl class="kv"><dt>HTTP status</dt><dd>${p.status_code || 'Error'}</dd>${d.redirectOnly ? `<dt>Redirects to</dt><dd class="mono">${esc(d.finalUrl)}</dd><dt>Redirect chain</dt><dd class="mono small">${(d.chain || []).map(c => `${c.status} ${esc(c.url)}`).join('<br>')}</dd>` : ''}${d.error ? `<dt>Error</dt><dd>${esc(d.error)}</dd>` : ''}<dt>In sitemap</dt><dd>${d.inSitemap ? 'Yes' : 'No'}</dd><dt>Found on</dt><dd class="mono small">${(d.foundFrom || []).map(u => esc(short(u))).join('<br>') || '—'}</dd></dl></div>
    ${p.issues.length ? `<div class="card mt"><h3 class="mb">Issues</h3>${p.issues.map(i => `<a class="list-issue" href="#/issues/${i.id}">${sevBadge(i.severity)}<span class="b">${esc(i.title)}</span></a>`).join('')}</div>` : ''}`;
    return;
  }
  const imgs = pg.images || [];
  const withAlt = imgs.filter(i => i.alt !== null || i.decorative).length;
  const cwv = p.cwv && !p.cwv.error && new URL(p.cwv.url).pathname === new URL(p.url).pathname ? p.cwv : null;
  const row = (label, value, status = '') => `<dt>${label}</dt><dd>${status ? status + ' ' : ''}${value}</dd>`;

  el.innerHTML = `
  <a href="javascript:history.back()" class="small b row" style="text-decoration:none;gap:4px;margin-bottom:10px"><span style="width:16px;display:inline-flex">${icons.back}</span>Back</a>
  <div class="card row" style="gap:24px;flex-wrap:nowrap">
    ${ring(p.score, 120, 10)}
    <div style="min-width:0;flex:1"><span class="eyebrow">Page analysis · ${esc(p.page_type)}</span>
      <h1 class="mono" style="font-size:20px;word-break:break-all;margin-top:4px">${esc(short(p.url))}</h1>
      <div class="row mt-s"><span class="badge ${p.status_code === 200 ? 'ok' : 'crit'}">HTTP ${p.status_code}</span>${p.indexable ? '<span class="badge ok">Indexable</span>' : `<span class="badge grey">Not indexable${pg.noindex ? ' · noindex' : d.canonicalisedTo ? ' · canonicalised' : !d.robotsAllowed ? ' · robots.txt' : ''}</span>`}${d.inSitemap ? '<span class="badge info">In sitemap</span>' : ''}
        ${issuesHere.filter(i => i.severity === 'critical').length ? `<span class="badge crit">${issuesHere.filter(i => i.severity === 'critical').length} critical</span>` : ''}${issuesHere.filter(i => i.severity === 'warning').length ? `<span class="badge warn">${issuesHere.filter(i => i.severity === 'warning').length} warnings</span>` : ''}
        <a class="small b" href="${esc(p.url)}" target="_blank" rel="noopener">Open page ↗</a>
        <a class="small b" href="#/assistant?q=${encodeURIComponent('Why did ' + short(p.url) + ' fail?')}">Ask the assistant ✦</a></div>
    </div>
  </div>

  <div class="grid g2 mt">
    <div class="card"><div class="card-h"><h3>On-page SEO</h3>${srcBadge('auto')}</div>
      <dl class="kv">
        ${row('Title', `${esc(pg.title || '— missing —')} <span class="muted small">(${pg.titleLength} chars)</span>`, ok(pg.titleLength >= T['title-length'].min && pg.titleLength <= T['title-length'].max, pg.title ? '' : 'crit'))}
        ${row('Meta description', `${esc(pg.metaDescription || '— missing —')} <span class="muted small">(${pg.metaLength} chars)</span>`, ok(pg.metaLength >= T['meta-length'].min && pg.metaLength <= T['meta-length'].max, pg.metaDescription ? '' : 'crit'))}
        ${row('H1', pg.h1s.length ? pg.h1s.map(h => esc(h || '(empty)')).join('<br>') : '— missing —', ok(pg.h1s.length === 1 && pg.h1s[0], 'crit'))}
        ${row('Canonical', pg.canonical ? `<span class="mono small">${esc(pg.canonical)}</span>` : '— missing —', ok(!!pg.canonical))}
        ${row('Meta robots', esc(pg.metaRobots || 'index, follow (default)'), ok(!pg.noindex))}
        ${row('Language', esc(pg.lang || '— missing —'), ok(!!pg.lang))}
        ${row('Word count', pg.wordCount, ok(pg.wordCount >= (T['thin-content'].minWords || 250)))}
        ${row('Primary topic', `${esc((d.topic || []).join(' ') || '—')} ${srcBadge('heuristic')}`)}
      </dl>
    </div>
    <div class="card"><div class="card-h"><h3>Links, media & technical</h3>${srcBadge('auto')}</div>
      <dl class="kv">
        ${row('Internal links', `${d.outlinks.length} outgoing · ${d.inlinks.length} incoming`, ok(d.outlinks.length >= 3 && (d.inlinks.length > 0 || p.page_type === 'home')))}
        ${row('External links', pg.externalLinks.length)}
        ${row('Images', `${imgs.length} · alt text ${withAlt}/${imgs.length}`, ok(withAlt === imgs.length))}
        ${row('Structured data', esc(pg.schemaTypes.join(', ') || 'None'), ok(pg.schemaTypes.length > 0))}
        ${row('Server response', d.ttfb != null ? `${d.ttfb} ms` : '–', ok((d.ttfb || 0) <= (T['response-time'].maxMs || 800)))}
        ${row('HTML size', `${Math.round((d.bytes || 0) / 1024)} KB`)}
        ${row('Mobile viewport', esc(pg.viewport || '— missing —'), ok(/device-width/.test(pg.viewport || ''), 'crit'))}
        ${row('LCP / INP / CLS', cwv ? `${cwv.lcp != null ? (cwv.lcp / 1000).toFixed(1) + 's' : '–'} / ${cwv.inp ?? '–'}ms / ${cwv.cls?.toFixed?.(2) ?? '–'} <span class="muted small">(${esc(cwv.source)})</span>` : `<span class="muted">Not measured</span> ${srcBadge('manual')}`)}
      </dl>
    </div>
  </div>

  <div class="card mt"><div class="card-h"><h3>Issues on this page</h3><span class="small muted">${issuesHere.length} open</span></div>
    ${issuesHere.length ? issuesHere.map(i => `<a class="list-issue" href="#/issues/${i.id}">${sevBadge(i.severity)}<div style="min-width:0"><div class="b">${esc(i.title)}</div><div class="small muted">${esc((i.current_value || '').slice(0, 200))}</div></div></a>`).join('') : '<div class="empty" style="padding:20px">✓ No open issues on this page.</div>'}
    ${linkedIssues.length ? `<div class="hr"></div><div class="small b mb">Related issues (this page links to a problem URL or shares a duplicate)</div>${linkedIssues.map(i => `<a class="list-issue" href="#/issues/${i.id}">${sevBadge(i.severity)}<div><div class="b">${esc(i.title)}</div><div class="small mono muted">${esc(short(i.url))}</div></div></a>`).join('')}` : ''}
  </div>

  <div class="grid g2 mt">
    <div class="card"><h3 class="mb">Heading outline</h3>
      <div class="small" style="max-height:360px;overflow:auto">${pg.headings.length ? pg.headings.map(h => `<div style="padding:3px 0 3px ${(h.level - 1) * 16}px"><span class="badge ${h.level === 1 ? 'yellow' : 'grey'}">H${h.level}</span> ${esc(h.text || '(empty)')}</div>`).join('') : '<span class="muted">No headings.</span>'}</div></div>
    <div class="card"><h3 class="mb">Images (${imgs.length})</h3>
      <div style="max-height:360px;overflow:auto"><table class="tbl"><thead><tr><th>File</th><th>Alt</th><th>W×H</th></tr></thead><tbody>${imgs.map(i => `<tr><td class="mono small" style="word-break:break-all">${esc(i.filename || i.src)}</td><td class="small">${i.alt === null ? (i.decorative ? '<span class="muted">decorative</span>' : '<span class="badge crit">missing</span>') : esc(i.alt) || '<span class="muted">""</span>'}</td><td class="small">${i.width && i.height ? `${esc(i.width)}×${esc(i.height)}` : '<span class="badge warn">missing</span>'}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No images.</td></tr>'}</tbody></table></div></div>
  </div>
  <div class="grid g2 mt">
    <div class="card"><h3 class="mb">Linked from (${d.inlinks.length})</h3><div class="small mono" style="max-height:260px;overflow:auto">${d.inlinks.map(u => `<div>${esc(short(u))}</div>`).join('') || '<span class="muted">No internal links point to this page.</span>'}</div></div>
    <div class="card"><h3 class="mb">Links to (${d.outlinks.length})</h3><div class="small mono" style="max-height:260px;overflow:auto">${d.outlinks.map(u => `<div>${esc(short(u))}</div>`).join('') || '<span class="muted">None.</span>'}</div></div>
  </div>`;
}
