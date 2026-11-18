import { api } from '../api.js';
import { esc } from '../ui.js';

export const needsAudit = true;

export default async function (el, params, app) {
  const a = app.audit;
  const tree = await api.get(`/api/audits/${a.id}/structure`);
  const counts = { good: 0, weak: 0, orphan: 0, excluded: 0 };
  const walk = (n) => { if (n.pageId) counts[n.health]++; n.children.forEach(walk); };
  walk(tree);

  const nodeHtml = (n, isRoot) => {
    const virtual = !n.pageId;
    const cls = isRoot ? 'home' : virtual ? 'virtual' : n.health;
    const name = isRoot ? 'Homepage' : (n.title || n.name);
    const iss = n.issues || {};
    return `<li><button class="node ${cls}" ${virtual ? 'disabled' : `data-page="${n.pageId}"`} title="${esc(n.url || n.path)}">
      <span style="min-width:0"><span class="t trunc" style="display:block">${esc(name)}</span><span class="p">${esc(n.path)}${virtual ? ' · not crawled' : ''}</span></span>
      ${virtual ? '' : `<span class="meta">${n.status !== 200 ? `<span class="badge crit">${n.status}</span>` : ''}<span class="badge grey" title="Incoming internal links">↘ ${n.inlinks}</span>${iss.critical ? `<span class="badge crit">${iss.critical}</span>` : ''}${iss.warning ? `<span class="badge warn">${iss.warning}</span>` : ''}</span>`}
    </button>${n.children.length ? `<ul>${n.children.map(c => nodeHtml(c, false)).join('')}</ul>` : ''}</li>`;
  };

  el.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">Site structure · Audit #${a.id}</span><h1>Crawl map</h1><p>Page hierarchy from crawled URLs, colour-coded by internal linking. Click any page for its SEO analysis.</p></div></div>
  <div class="card row between" style="padding:14px 18px">
    <div class="legend">
      <span><i style="border-color:var(--ok);background:#f4fbf7"></i>Well connected (${counts.good})</span>
      <span><i style="border-color:var(--warn);background:#fff8ec"></i>Weak internal linking — 1–2 inlinks (${counts.weak})</span>
      <span><i style="border-color:var(--crit);background:#fff3f3"></i>Orphan — no inlinks (${counts.orphan})</span>
      <span><i style="border-color:#bdbdbd;background:#f6f6f6"></i>Not indexable (${counts.excluded})</span>
      <span><i style="border-style:dashed;border-color:#cfcfcf"></i>Path segment, not crawled</span>
    </div>
  </div>
  <div class="card mt" style="overflow:auto"><ul class="tree">${nodeHtml(tree, true)}</ul></div>`;
  el.querySelector('.tree').addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b) app.go(`pages/${b.dataset.page}`); });
}
