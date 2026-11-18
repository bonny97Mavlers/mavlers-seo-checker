'use strict';
/**
 * SEO Rules Engine — one implementation per standard id.
 * Thresholds/severity always come from the standard passed in (the Standards
 * Library), never hard-coded here.
 *
 * Page rule:  (page, std, ctx) => undefined (not applicable) | { pass: true } | { pass: false, title, current, detail?, key?, severity? }
 * Site rule:  (std, ctx)       => undefined (not evaluated)  | { evaluated: n, failures: [{ url, title, current, detail?, key?, severity? }] }
 */
const { tokens, topicCoverage } = require('./text');

const pass = { pass: true };
const fail = (title, current, detail, extra = {}) => ({ pass: false, title, current, detail, ...extra });
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return ''; } };
const short = (u) => { try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return u; } };
const kb = (b) => Math.round((b || 0) / 1024);

function maxAge(cc) { const m = /max-age=(\d+)/i.exec(cc || ''); return m ? Number(m[1]) : (/immutable/i.test(cc || '') ? 31536000 : 0); }

function groupDuplicates(pages, getter) {
  const map = new Map();
  for (const p of pages) {
    const v = (getter(p) || '').trim().toLowerCase();
    if (!v) continue;
    if (!map.has(v)) map.set(v, []);
    map.get(v).push(p);
  }
  return [...map.values()].filter(g => g.length > 1);
}

const PAGE_RULES = {
  // ── Titles & meta ──
  'title-missing': (p) => p.data.title ? pass : fail('Missing title tag', 'No <title> found'),
  'title-length': (p, s) => {
    const t = p.data.title; if (!t) return;
    const { min, max } = s.threshold;
    if (t.length > max) return fail(`Title too long (${t.length} chars)`, `${t.length} characters: "${t}"`, { length: t.length, value: t });
    if (t.length < min) return fail(`Title too short (${t.length} chars)`, `${t.length} characters: "${t}"`, { length: t.length, value: t });
    return pass;
  },
  'title-brand-suffix': (p, s, ctx) => {
    const t = p.data.title; if (!t) return;
    const brand = (s.threshold.brand || ctx.brand || '').toLowerCase();
    const seps = s.threshold.separators || ['|', '-'];
    const lower = t.toLowerCase();
    const sepIdx = Math.max(...seps.map(x => lower.lastIndexOf(' ' + x + ' ')), ...seps.map(x => lower.lastIndexOf(x)));
    if (brand) {
      if (lower.endsWith(brand) || (sepIdx > 0 && lower.slice(sepIdx).includes(brand))) return pass;
      return fail('Title missing brand suffix', `"${t}" — expected to end with "| ${ctx.brandDisplay || s.threshold.brand}"`, { value: t });
    }
    return sepIdx > 0 ? pass : fail('Title missing brand suffix', `"${t}" — no brand suffix separator found`, { value: t });
  },
  'meta-missing': (p) => p.data.metaDescription ? pass : fail('Missing meta description', 'No meta description found'),
  'meta-length': (p, s) => {
    const m = p.data.metaDescription; if (!m) return;
    const { min, max } = s.threshold;
    if (m.length > max) return fail(`Meta description too long (${m.length} chars)`, `${m.length} characters`, { length: m.length, value: m });
    if (m.length < min) return fail(`Meta description too short (${m.length} chars)`, `${m.length} characters`, { length: m.length, value: m });
    return pass;
  },
  'meta-cta': (p, s) => {
    const m = p.data.metaDescription; if (!m) return;
    const words = s.threshold.words || [];
    const lower = m.toLowerCase();
    return words.some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) ? pass
      : fail('Meta description has no call to action', `"${m}"`, { value: m });
  },
  'h1-missing': (p) => p.data.h1s.length ? pass : fail('Missing H1', 'No H1 element found'),
  'h1-multiple': (p) => p.data.h1s.length <= 1 ? (p.data.h1s.length ? pass : undefined)
    : fail(`${p.data.h1s.length} H1 elements detected`, p.data.h1s.map(h => `"${h || '(empty)'}"`).join(', '), { h1s: p.data.h1s }),
  'h1-empty': (p) => { if (!p.data.h1s.length) return; return p.data.h1s.some(h => !h) ? fail('Empty H1', 'An H1 element contains no text') : pass; },
  'heading-hierarchy': (p) => {
    const hs = p.data.headings; if (hs.length < 2) return;
    for (let i = 1; i < hs.length; i++) {
      if (hs[i].level > hs[i - 1].level + 1) return fail(`Heading level skipped (H${hs[i - 1].level} → H${hs[i].level})`, `"${hs[i - 1].text}" (H${hs[i - 1].level}) is followed by "${hs[i].text}" (H${hs[i].level})`);
    }
    return pass;
  },
  'h1-title-relevance': (p, s, ctx) => {
    const h1 = p.data.h1s[0]; const t = p.titleCore; if (!h1 || !t) return;
    const ht = tokens(h1); if (!ht.length) return;
    const tt = new Set(tokens(t));
    const overlap = ht.filter(x => tt.has(x)).length / ht.length;
    return overlap >= (s.threshold.minOverlap ?? 0.3) ? pass
      : fail('H1 and title target different topics', `Title: "${p.data.title}" · H1: "${h1}"`, { overlap: Math.round(overlap * 100) });
  },

  // ── URL & structure ──
  'url-lowercase': (p) => { const path = pathOf(p.url); return path === path.toLowerCase() ? pass : fail('URL contains uppercase characters', short(p.url)); },
  'url-hyphens': (p) => { const path = pathOf(p.url); return /_|%20|\+| /.test(path) ? fail('URL uses underscores/spaces instead of hyphens', short(p.url)) : pass; },
  'url-depth': (p, s) => { if (p.pageType === 'home') return; const d = pathOf(p.url).split('/').filter(Boolean).length; return d > s.threshold.maxDepth ? fail(`URL is ${d} levels deep`, short(p.url), { depth: d }) : pass; },
  'url-params': (p) => { const u = new URL(p.url); const keys = [...u.searchParams.keys()].filter(k => !/^(page|paged)$/i.test(k)); return keys.length ? fail('Indexable URL uses query parameters', short(p.url)) : pass; },
  'url-slug-length': (p, s) => {
    if (p.pageType === 'home') return;
    const slug = pathOf(p.url).split('/').filter(Boolean).pop() || '';
    if (slug.length > s.threshold.maxLength) return fail(`Slug is long (${slug.length} chars)`, slug);
    if (/^\d+$/.test(slug) || /^[a-f0-9]{12,}$/i.test(slug)) return fail('Slug is not descriptive (numeric/ID)', slug);
    return pass;
  },
  'internal-links-low': (p, s, ctx) => {
    if (!ctx.options.internalLinks) return;
    const n = p.outlinks.length;
    return n < s.threshold.min ? fail(`Only ${n} internal link${n === 1 ? '' : 's'} on page`, `${n} unique internal links`, { count: n }) : pass;
  },
  'internal-links-high': (p, s) => { const n = p.outlinks.length; return n > s.threshold.max ? fail(`${n} internal links on page`, `${n} unique internal links`, { count: n }) : pass; },

  // ── Content ──
  'keyword-first-100': (p) => { if (!p.topic.length || p.data.wordCount < 50) return; return topicCoverage(p.topic, p.data.first100) >= 0.5 ? pass : fail('Primary topic not in first 100 words', `Topic "${p.topic.join(' ')}" not found in the opening copy`, { topic: p.topic }); },
  'keyword-url': (p) => { if (!p.topic.length) return; return topicCoverage(p.topic, pathOf(p.url).replace(/[-_/]/g, ' ')) >= 0.5 ? pass : fail('Primary topic not in URL', `Topic "${p.topic.join(' ')}" vs slug ${short(p.url)}`, { topic: p.topic }); },
  'keyword-meta': (p) => { if (!p.topic.length || !p.data.metaDescription) return; return topicCoverage(p.topic, p.data.metaDescription) >= 0.5 ? pass : fail('Primary topic not in meta description', `Topic "${p.topic.join(' ')}" not in: "${p.data.metaDescription}"`, { topic: p.topic }); },
  'subheadings': (p, s) => { if (p.data.wordCount < s.threshold.minWords) return; return p.data.headings.some(h => h.level === 2) ? pass : fail('No H2 subheadings', `${p.data.wordCount} words with no H2 sections`); },
  'scannable': (p, s) => {
    if (p.data.wordCount < s.threshold.minWords) return;
    if (p.data.longParagraphs) return fail(`${p.data.longParagraphs} very long paragraph(s)`, 'Paragraphs over 150 words');
    if (!p.data.lists && p.data.headings.filter(h => h.level === 2).length < 2) return fail('Long content with no lists or sections', `${p.data.wordCount} words, no lists and fewer than 2 H2s`);
    return pass;
  },
  'thin-content': (p, s) => p.data.wordCount < s.threshold.minWords ? fail(`Thin content (${p.data.wordCount} words)`, `${p.data.wordCount} words of main content`, { words: p.data.wordCount }) : pass,

  // ── Images ──
  'img-alt-missing': (p) => {
    const imgs = p.data.images; if (!imgs.length) return;
    const bad = imgs.filter(i => i.alt === null && !i.decorative);
    return bad.length ? fail(`${bad.length} image${bad.length > 1 ? 's' : ''} missing alt text`, `${imgs.length - bad.length} of ${imgs.length} images have alt text`, { images: bad.slice(0, 25).map(i => i.src), count: bad.length, total: imgs.length }) : pass;
  },
  'img-alt-generic': (p, s) => {
    const imgs = p.data.images.filter(i => i.alt); if (!imgs.length) return;
    const generic = new Set((s.threshold.generic || []).map(x => x.toLowerCase()));
    const bad = imgs.filter(i => generic.has(i.alt.toLowerCase()) || /\.(jpe?g|png|webp|gif|svg)$/i.test(i.alt) || /^(img|dsc|image|photo|screenshot)[-_ ]?\d+/i.test(i.alt) || i.alt.length < 4);
    return bad.length ? fail(`${bad.length} image${bad.length > 1 ? 's' : ''} with generic alt text`, bad.slice(0, 5).map(i => `"${i.alt}"`).join(', '), { images: bad.slice(0, 25).map(i => ({ src: i.src, alt: i.alt })), count: bad.length }) : pass;
  },
  'img-filename': (p) => {
    const imgs = p.data.images.filter(i => i.filename && !/^data:/.test(i.src)); if (!imgs.length) return;
    const bad = imgs.filter(i => / |_|%20/.test(i.filename) || /^(img|dsc|dscn|dscf|pxl|screenshot|screen-shot|image|photo|whatsapp|untitled)[-_ ]?\d*/i.test(i.filename) || /^[a-f0-9-]{20,}\.[a-z]+$/i.test(i.filename) || /^\d+\.[a-z]+$/i.test(i.filename));
    return bad.length ? fail(`${bad.length} image filename${bad.length > 1 ? 's' : ''} need improvement`, bad.slice(0, 5).map(i => i.filename).join(', '), { images: bad.slice(0, 25).map(i => i.filename), count: bad.length }) : pass;
  },
  'img-format': (p, s, ctx) => {
    const imgs = p.data.images.filter(i => ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff'].includes(i.ext)); if (!p.data.images.length) return;
    const bad = imgs.filter(i => !i.pictureWebp && !/image\/(webp|avif)/.test(ctx.site.imageSizes?.[i.src]?.type || ''));
    return bad.length ? fail(`${bad.length} image${bad.length > 1 ? 's' : ''} not in WebP/AVIF`, bad.slice(0, 5).map(i => i.filename).join(', '), { images: bad.slice(0, 25).map(i => i.src), count: bad.length }) : pass;
  },
  'img-dimensions': (p) => {
    const imgs = p.data.images.filter(i => i.ext !== 'svg'); if (!imgs.length) return;
    const bad = imgs.filter(i => !i.width || !i.height);
    return bad.length ? fail(`${bad.length} image${bad.length > 1 ? 's' : ''} missing width/height`, `${imgs.length - bad.length} of ${imgs.length} images declare dimensions`, { images: bad.slice(0, 25).map(i => i.src), count: bad.length, total: imgs.length }) : pass;
  },

  // ── Indexing ──
  'noindex-review': (p, s, ctx) => { if (ctx.stagingBlocked) return; return p.data.noindex ? fail('Content page is set to noindex', `meta robots: "${p.data.metaRobots || p.data.xRobots}"`) : pass; },
  'utility-noindex': (p) => p.data.noindex || !p.robotsAllowed ? pass : fail('Utility page is indexable', `${short(p.url)} should be noindexed`),
  'canonical-missing': (p) => p.data.canonical ? pass : fail('Missing canonical tag', 'No <link rel="canonical">'),
  'canonical-target': (p, s, ctx) => {
    const c = p.data.canonical; if (!c) return;
    if (p.data.canonicalCount > 1) return fail('Multiple canonical tags', `${p.data.canonicalCount} canonical tags found`);
    if (ctx.norm(c) === ctx.norm(p.url)) return pass;
    const cu = new URL(c); const pu = new URL(p.url);
    if (cu.protocol !== pu.protocol && cu.hostname === pu.hostname) return fail('Canonical points to a different protocol', c);
    const st = ctx.linkStatus[c] || ctx.linkStatus[ctx.norm(c)];
    const tgt = ctx.byUrl.get(ctx.norm(c));
    if (st && (st.status >= 400 || st.status === 0)) return fail('Canonical points to a broken URL', `${c} → HTTP ${st.status || st.error}`);
    if (st && st.hops > 0) return fail('Canonical points to a redirect', `${c} redirects to ${st.finalUrl}`);
    if (tgt?.data?.noindex) return fail('Canonical points to a noindexed page', c);
    if (!ctx.sameSite(c)) return fail('Canonical points to another domain', c, null, { severity: 'critical' });
    return pass; // deliberate canonicalisation to a valid page
  },

  // ── Schema ──
  'schema-valid': (p) => { if (!p.data.jsonld.length) return; const bad = p.data.jsonld.filter(j => !j.valid); return bad.length ? fail('Invalid JSON-LD structured data', bad[0].error, { errors: bad }) : pass; },
  'schema-website': (p) => p.data.schemaTypes.includes('WebSite') ? pass : fail('Homepage missing WebSite schema', `Found: ${p.data.schemaTypes.join(', ') || 'none'}`),
  'schema-breadcrumb': (p) => p.data.schemaTypes.includes('BreadcrumbList') ? pass
    : fail('Missing BreadcrumbList schema', p.data.breadcrumbHtml ? 'Visible breadcrumbs found but no BreadcrumbList schema' : 'No breadcrumbs or BreadcrumbList schema'),
  'schema-article': (p, s) => {
    const obj = p.data.schemaObjects.find(o => [].concat(o['@type']).some(t => /^(Article|BlogPosting|NewsArticle|TechArticle)$/.test(t)));
    if (!obj) return fail('Blog post missing Article/BlogPosting schema', `Found: ${p.data.schemaTypes.join(', ') || 'none'}`);
    const missing = (s.threshold.required || []).filter(k => obj[k] == null || obj[k] === '');
    return missing.length ? fail(`Article schema missing ${missing.join(', ')}`, `Missing: ${missing.join(', ')}`, { missing }) : pass;
  },
  'schema-product': (p, s) => {
    const obj = p.data.schemaObjects.find(o => [].concat(o['@type']).includes('Product'));
    if (!obj) return fail('Product page missing Product schema', `Found: ${p.data.schemaTypes.join(', ') || 'none'}`);
    const missing = (s.threshold.required || []).filter(k => obj[k] == null);
    const offer = [].concat(obj.offers || [])[0];
    if (offer) for (const k of ['price', 'priceCurrency', 'availability']) if (offer[k] == null && !(k === 'price' && offer.lowPrice != null)) missing.push('offers.' + k);
    return missing.length ? fail(`Product schema missing ${missing.join(', ')}`, `Missing: ${missing.join(', ')}${obj.aggregateRating ? '' : ' (no aggregateRating — add if reviews exist)'}`, { missing }) : pass;
  },
  'schema-faq': (p, s) => {
    if (p.data.questionHeadings < (s.threshold.minQuestions || 3)) return;
    return p.data.schemaTypes.includes('FAQPage') ? pass : fail('FAQ-style content without FAQPage schema', `${p.data.questionHeadings} question headings found`);
  },

  // ── Technical ──
  'mixed-content': (p) => { if (!p.url.startsWith('https:')) return; return p.data.mixedContent.length ? fail(`${p.data.mixedContent.length} insecure http:// resource(s)`, p.data.mixedContent.slice(0, 3).join(', '), { resources: p.data.mixedContent }) : pass; },
  'viewport': (p) => /width\s*=\s*device-width/i.test(p.data.viewport || '') ? pass : fail('Missing responsive viewport', p.data.viewport ? `viewport="${p.data.viewport}"` : 'No viewport meta tag'),
  'lang': (p) => p.data.lang ? pass : fail('Missing lang attribute', '<html> has no lang attribute'),
  'charset': (p) => p.data.charset || /charset=/i.test(p.headers['content-type'] || '') ? pass : fail('Character encoding not declared', 'No <meta charset>'),

  // ── Performance ──
  'response-time': (p, s) => p.ttfb == null ? undefined : p.ttfb > s.threshold.maxMs ? fail(`Slow server response (${p.ttfb} ms)`, `${p.ttfb} ms time to first byte`, { ms: p.ttfb }) : pass,
  'html-size': (p, s) => kb(p.bytes) > s.threshold.maxKb ? fail(`Large HTML document (${kb(p.bytes)} KB)`, `${kb(p.bytes)} KB`) : pass,
  'render-blocking': (p, s) => p.data.renderBlockingScripts > s.threshold.max ? fail(`${p.data.renderBlockingScripts} render-blocking scripts`, `${p.data.renderBlockingScripts} scripts in <head> without async/defer`) : pass,

  // ── AI readiness ──
  'semantic-html': (p) => { const s = p.data.semantic; const missing = ['main', 'header', 'footer'].filter(k => !s[k]); return missing.length ? fail(`Missing semantic element${missing.length > 1 ? 's' : ''}: ${missing.map(m => `<${m}>`).join(', ')}`, `No ${missing.map(m => `<${m}>`).join(', ')}`) : pass; },
  'structured-data-present': (p) => p.data.schemaTypes.length ? pass : fail('No structured data on page', 'No JSON-LD or microdata found'),
  'qa-headings': (p, s) => { if (p.data.wordCount < s.threshold.minWords) return; return p.data.questionHeadings ? pass : fail('No question-style headings', `${p.data.wordCount} words, no Q&A-style headings`); },
};

const SITE_RULES = {
  'title-duplicate': (s, ctx) => dupRule(ctx.indexable, p => p.data.title, 'Duplicate title', v => `Same title on {n} pages: "${v}"`),
  'meta-duplicate': (s, ctx) => dupRule(ctx.indexable, p => p.data.metaDescription, 'Duplicate meta description', v => `Same description on {n} pages`),
  'h1-duplicate': (s, ctx) => dupRule(ctx.indexable, p => p.data.h1s[0], 'Duplicate H1', v => `Same H1 on {n} pages: "${v}"`),
  'duplicate-content': (s, ctx) => dupRule(ctx.indexable, p => p.data.contentHash, 'Duplicate page content', () => 'Identical main content on {n} URLs'),

  'trailing-slash': (s, ctx) => {
    let withSlash = 0, without = 0; const exW = [], exWo = [];
    for (const p of ctx.html) for (const l of p.data.internalLinks) {
      const path = pathOf(l.href); if (path === '/' || /\.[a-z0-9]{2,5}$/i.test(path)) continue;
      if (path.endsWith('/')) { withSlash++; if (exW.length < 3) exW.push(path); } else { without++; if (exWo.length < 3) exWo.push(path); }
    }
    const total = withSlash + without; if (!total) return;
    const minority = Math.min(withSlash, without);
    if (minority / total <= 0.1) return { evaluated: 1, failures: [] };
    return { evaluated: 1, failures: [{ url: ctx.site.startUrl, title: 'Mixed trailing-slash URLs in internal links', current: `${withSlash} links with trailing slash (e.g. ${exW.join(', ')}), ${without} without (e.g. ${exWo.join(', ')})` }] };
  },
  'orphan-pages': (s, ctx) => {
    if (!ctx.options.internalLinks) return;
    const cand = ctx.indexable.filter(p => p.pageType !== 'home');
    return { evaluated: cand.length, failures: cand.filter(p => p.inlinks.length === 0).map(p => ({ url: p.url, title: 'Orphan page (no internal links point here)', current: p.inSitemap ? 'Found only in the XML sitemap' : 'No inbound internal links from crawled pages' })) };
  },
  'broken-internal-links': (s, ctx) => {
    const failures = []; let evaluated = 0;
    for (const [target, sources] of ctx.linkTargets) {
      const st = ctx.linkStatus[target]; if (!st) continue;
      evaluated++;
      if (st.status >= 400 || (st.status === 0 && !st.loop)) failures.push({ url: target, title: `Broken internal link (${st.status ? 'HTTP ' + st.status : st.error})`, current: `Linked from ${sources.size} page${sources.size > 1 ? 's' : ''}`, detail: { sources: [...sources].slice(0, 30), status: st.status, error: st.error } });
    }
    return { evaluated, failures };
  },
  'internal-redirect-links': (s, ctx) => {
    const failures = []; let evaluated = 0;
    for (const [target, sources] of ctx.linkTargets) {
      const st = ctx.linkStatus[target]; if (!st || st.status >= 400 || st.status === 0) continue;
      evaluated++;
      if (st.hops > 0) failures.push({ url: target, title: 'Internal link points to a redirect', current: `${short(target)} → ${short(st.finalUrl)} · linked from ${sources.size} page${sources.size > 1 ? 's' : ''}`, detail: { sources: [...sources].slice(0, 30), finalUrl: st.finalUrl } });
    }
    return { evaluated, failures };
  },
  'broken-external-links': (s, ctx) => {
    if (!ctx.options.externalLinks) return;
    const failures = []; const entries = Object.entries(ctx.site.externalLinkStatus || {});
    const sourcesOf = (u) => ctx.html.filter(p => p.data.externalLinks.some(l => l.href === u)).map(p => p.url).slice(0, 20);
    for (const [u, st] of entries) {
      if ([401, 403, 429, 999].includes(st.status)) continue; // bot-protected, not verifiable
      if (st.status >= 400 || st.status === 0) failures.push({ url: u, title: `Broken external link (${st.status ? 'HTTP ' + st.status : st.error})`, current: u, detail: { sources: sourcesOf(u) } });
    }
    return { evaluated: entries.length, failures };
  },
  'cannibalisation': (s, ctx) => {
    const groups = ctx.cannibalGroups;
    return { evaluated: ctx.indexable.length, failures: groups.map(g => ({ url: g.pages[0], key: g.pages.map(short).sort().join('+'), title: `Potential keyword cannibalisation (${g.pages.length} pages)`, current: `${g.pages.map(short).join(', ')} appear to target "${g.topic}"`, detail: { pages: g.pages, topic: g.topic, similarity: g.similarity } })) };
  },
  'img-oversized': (s, ctx) => {
    const entries = Object.entries(ctx.site.imageSizes || {}).filter(([, v]) => v.bytes);
    if (!entries.length) return;
    const max = (s.threshold.maxKb || 200) * 1024;
    const usedOn = (src) => ctx.html.filter(p => p.data.images.some(i => i.src === src)).map(p => p.url).slice(0, 10);
    return { evaluated: entries.length, failures: entries.filter(([, v]) => v.bytes > max).map(([src, v]) => ({ url: usedOn(src)[0] || src, key: src, title: `Oversized image (${kb(v.bytes)} KB)`, current: `${src.split('/').pop()} is ${kb(v.bytes)} KB`, detail: { src, bytes: v.bytes, usedOn: usedOn(src) } })) };
  },

  // ── Indexing ──
  'https': (s, ctx) => ({ evaluated: 1, failures: ctx.site.https ? [] : [{ url: ctx.site.startUrl, title: 'Site is not served over HTTPS', current: ctx.site.startUrl }] }),
  'host-canonicalisation': (s, ctx) => {
    const hc = ctx.site.hostChecks; if (!hc || !Object.keys(hc).length) return;
    const preferred = new URL(ctx.site.startUrl).origin;
    const failures = [];
    for (const [variant, r] of Object.entries(hc)) {
      if (r.status === 0 && /ENOTFOUND|resolve|EAI_AGAIN/i.test(r.error || '')) continue; // variant doesn't exist in DNS — fine
      if (r.status === 0) { if (variant.startsWith('https://www.') || variant.startsWith('https://')) { /* TLS failure on unused variant */ } continue; }
      let finalOrigin; try { finalOrigin = new URL(r.finalUrl).origin; } catch { continue; }
      if (finalOrigin !== preferred) failures.push({ url: variant, key: variant, title: 'Host/protocol variant not redirected to the preferred URL', current: `${variant} resolves to ${r.finalUrl} (HTTP ${r.status}) instead of ${preferred}/` });
      else if (r.hops > 1) failures.push({ url: variant, key: variant, title: `Host variant redirects in ${r.hops} hops`, current: [variant, ...r.chain.slice(1).map(c => c.url), r.finalUrl].join(' → '), severity: 'warning' });
    }
    return { evaluated: Object.keys(hc).length, failures };
  },
  'robots-exists': (s, ctx) => ({ evaluated: 1, failures: ctx.site.robots.exists ? [] : [{ url: ctx.site.robots.url, title: 'robots.txt missing', current: `HTTP ${ctx.site.robots.status}` }] }),
  'robots-blocks-all': (s, ctx) => { if (!ctx.site.robots.exists || ctx.stagingBlocked) return { evaluated: 1, failures: [] }; return { evaluated: 1, failures: ctx.site.robots.blocksAll ? [{ url: ctx.site.robots.url, title: 'robots.txt blocks the entire site', current: 'User-agent: * / Disallow: /' }] : [] }; },
  'robots-admin': (s, ctx) => { if (!ctx.site.robots.exists || ctx.cms !== 'WordPress') return; return { evaluated: 1, failures: ctx.site.robots.disallowsAdmin ? [] : [{ url: ctx.site.robots.url, title: 'robots.txt does not block /wp-admin/', current: 'No Disallow rule for /wp-admin/' }] }; },
  'robots-sitemap-ref': (s, ctx) => { if (!ctx.site.robots.exists) return; return { evaluated: 1, failures: ctx.site.robots.sitemaps.length ? [] : [{ url: ctx.site.robots.url, title: 'robots.txt does not reference the sitemap', current: 'No Sitemap: line' }] }; },
  'sitemap-exists': (s, ctx) => { if (!ctx.options.sitemap) return; return { evaluated: 1, failures: ctx.site.sitemap?.found?.length ? [] : [{ url: ctx.site.origin + '/sitemap.xml', title: 'No XML sitemap found', current: `Checked: ${(ctx.site.sitemap?.checked || []).map(c => `${short(c.url)} (${c.status || c.error})`).join(', ')}` }] }; },
  'sitemap-quality': (s, ctx) => {
    if (!ctx.site.sitemap?.found?.length) return;
    const inSm = ctx.all.filter(p => p.inSitemap);
    const failures = [];
    for (const p of inSm) {
      let why = null;
      if (p.redirectOnly || p.chain.length) why = `redirects to ${short(p.finalUrl)}`;
      else if (p.status !== 200) why = `returns HTTP ${p.status || p.error}`;
      else if (p.data?.noindex) why = 'is set to noindex';
      else if (p.canonicalisedTo) why = `canonicalises to ${short(p.canonicalisedTo)}`;
      if (why) failures.push({ url: p.url, title: 'Non-indexable URL in XML sitemap', current: `Sitemap URL ${why}` });
    }
    if (ctx.site.sitemap.errors?.length) failures.push({ url: ctx.site.origin, key: 'sitemap-errors', title: 'Declared sitemap could not be read', current: ctx.site.sitemap.errors.join('; ') });
    return { evaluated: inSm.length + 1, failures };
  },
  'noindex-home': (s, ctx) => {
    const h = ctx.home; if (!h || ctx.stagingBlocked) return { evaluated: 1, failures: [] };
    const why = h.data.noindex ? `meta robots "${h.data.metaRobots || h.data.xRobots}"` : !h.robotsAllowed ? 'blocked by robots.txt' : null;
    return { evaluated: 1, failures: why ? [{ url: h.url, title: 'Homepage is not indexable', current: why }] : [] };
  },
  'staging-detected': (s, ctx) => {
    const failures = [];
    if (ctx.site.stagingHost) {
      if (ctx.stagingBlocked) failures.push({ url: ctx.site.startUrl, key: 'staging-blocked', severity: 'warning', title: 'Staging environment detected (correctly blocked from indexing)', current: `${ctx.site.host} is a staging/dev hostname and is blocked from indexing. Remove the block at go-live and re-run this audit on the live domain.` });
      else failures.push({ url: ctx.site.startUrl, key: 'staging-indexable', title: 'Potential staging environment is crawlable/indexable', current: `${ctx.site.host} looks like a staging/dev hostname and is NOT blocked (no noindex, robots.txt allows crawling). Review indexing and access restrictions before launch.` });
    }
    const refs = new Map();
    for (const p of ctx.html) for (const r of p.data.stagingRefs) { if (!refs.has(r)) refs.set(r, []); refs.get(r).push(p.url); }
    for (const [origin, pagesUsing] of refs) failures.push({ url: pagesUsing[0], key: origin, title: 'Links/assets point to a staging environment', current: `${origin} referenced on ${pagesUsing.length} page${pagesUsing.length > 1 ? 's' : ''}`, detail: { origin, pages: pagesUsing.slice(0, 30) } });
    return { evaluated: 1 + ctx.html.length, failures };
  },
  'custom-404': (s, ctx) => {
    const nf = ctx.site.notFound; if (!nf) return;
    if (nf.status === 404 || nf.status === 410) return { evaluated: 1, failures: [] };
    const why = nf.redirectsHome ? 'redirects to the homepage' : nf.status === 200 ? 'returns HTTP 200 (soft 404)' : `returns HTTP ${nf.status || 'error'}`;
    return { evaluated: 1, failures: [{ url: ctx.site.startUrl, key: 'not-found-probe', title: 'Unknown URLs do not return a 404', current: `A non-existent URL (${nf.url}) ${why}` }] };
  },
  'redirect-chains': (s, ctx) => {
    const failures = []; let evaluated = 0;
    for (const [u, st] of Object.entries(ctx.linkStatus)) {
      if (!st) continue; evaluated++;
      if (st.loop) failures.push({ url: u, title: 'Redirect loop', current: `${short(u)} redirects in a loop`, severity: 'critical' });
      else if (st.hops > 1) failures.push({ url: u, title: `Redirect chain (${st.hops} hops)`, current: `${short(u)} → … → ${short(st.finalUrl)}`, severity: 'warning' });
    }
    return { evaluated, failures };
  },
  'page-errors': (s, ctx) => {
    // URLs reached via internal links are reported by broken-internal-links; this rule covers sitemap/start URLs.
    const failures = ctx.all.filter(p => (p.status >= 400 || (p.status === 0 && !p.loop)) && (p.inSitemap || !ctx.linkTargets.has(ctx.norm(p.url)))).map(p => ({ url: p.url, title: p.status ? `Page returns HTTP ${p.status}` : `Page could not be fetched`, current: p.status ? `HTTP ${p.status}${p.inSitemap ? ' (listed in sitemap)' : ''}` : p.error, severity: p.status >= 500 || p.status === 0 || p.inSitemap ? 'critical' : 'warning' }));
    return { evaluated: ctx.all.length, failures };
  },
  'robots-blocked-pages': (s, ctx) => {
    if (!ctx.site.robots.exists || ctx.site.robots.blocksAll) return;
    const cand = ctx.html.filter(p => p.pageType !== 'utility');
    return { evaluated: cand.length, failures: cand.filter(p => !p.robotsAllowed).map(p => ({ url: p.url, title: 'Page blocked by robots.txt', current: `${short(p.url)} is disallowed${p.inSitemap ? ' but listed in the sitemap' : ''}` })) };
  },

  // ── Technical (site-level) ──
  'favicon': (s, ctx) => ctx.home ? { evaluated: 1, failures: ctx.home.data.favicon ? [] : [{ url: ctx.home.url, title: 'No favicon declared', current: 'No <link rel="icon">' }] } : undefined,
  'touch-icon': (s, ctx) => ctx.home ? { evaluated: 1, failures: ctx.home.data.touchIcon ? [] : [{ url: ctx.home.url, title: 'No apple-touch-icon declared', current: 'No <link rel="apple-touch-icon">' }] } : undefined,
  'compression': (s, ctx) => { if (!ctx.options.technical || !ctx.home) return; return { evaluated: 1, failures: /gzip|br|deflate|zstd/i.test(ctx.site.htmlCompression || '') ? [] : [{ url: ctx.home.url, title: 'HTML not compressed', current: 'No gzip/Brotli content-encoding on the HTML response' }] }; },
  'caching': (s, ctx) => {
    const assets = Object.entries(ctx.site.assets || {}).filter(([, a]) => a.status === 200); if (!assets.length) return;
    const bad = assets.filter(([, a]) => maxAge(a.cacheControl) < (s.threshold.minMaxAge || 86400));
    return { evaluated: 1, failures: bad.length > assets.length / 2 ? [{ url: ctx.site.startUrl, title: 'Static assets lack long-lived caching', current: `${bad.length} of ${assets.length} sampled CSS/JS files have short or no Cache-Control max-age`, detail: { assets: bad.map(([u, a]) => ({ url: u, cacheControl: a.cacheControl })) } }] : [] };
  },
  'minification': (s, ctx) => {
    const assets = Object.entries(ctx.site.assets || {}).filter(([, a]) => a.status === 200 && a.sameHost); if (!assets.length) return;
    const bad = assets.filter(([, a]) => !a.minified);
    return { evaluated: 1, failures: bad.length ? [{ url: ctx.site.startUrl, title: `${bad.length} CSS/JS file${bad.length > 1 ? 's' : ''} not minified`, current: bad.map(([u]) => u.split('/').pop()).join(', '), detail: { assets: bad.map(([u]) => u) } }] : [] };
  },

  // ── Performance (CWV via PageSpeed Insights, optional) ──
  'cwv-lcp': (s, ctx) => cwv(ctx, 'lcp', v => v > s.threshold.maxMs, v => `LCP ${(v / 1000).toFixed(1)} s`),
  'cwv-inp': (s, ctx) => cwv(ctx, 'inp', v => v > s.threshold.maxMs, v => `INP ${Math.round(v)} ms`),
  'cwv-cls': (s, ctx) => cwv(ctx, 'cls', v => v > s.threshold.max, v => `CLS ${v.toFixed(2)}`),

  // ── Tracking ──
  'analytics': (s, ctx) => { const found = ctx.html.some(p => p.data.tracking.ga4.length || p.data.tracking.gtm.length); return { evaluated: 1, failures: found ? [] : [{ url: ctx.site.startUrl, title: 'No GA4 or Google Tag Manager detected', current: 'No G- or GTM- container IDs found in page source' }] }; },
  'legacy-ua': (s, ctx) => ({ evaluated: 1, failures: ctx.html.some(p => p.data.tracking.uaLegacy) ? [{ url: ctx.site.startUrl, title: 'Legacy Universal Analytics tag found', current: 'UA- tracking ID present' }] : [] }),
  'seo-plugin': (s, ctx) => { if (ctx.cms !== 'WordPress') return; return { evaluated: 1, failures: ctx.seoPlugin ? [] : [{ url: ctx.site.startUrl, title: 'No SEO plugin detected (Yoast / Rank Math)', current: 'WordPress site without a recognised SEO plugin signature' }] }; },
};

function dupRule(pages, getter, title, describe) {
  const groups = groupDuplicates(pages, getter);
  const failures = [];
  for (const g of groups) {
    const v = getter(g[0]);
    for (const p of g) failures.push({ url: p.url, title, current: describe(String(v).slice(0, 120)).replace('{n}', g.length), detail: { value: v, urls: g.map(x => x.url) } });
  }
  return { evaluated: pages.length, failures };
}

function cwv(ctx, metric, isBad, label) {
  const c = ctx.site.cwv; if (!c || c[metric] == null) return;
  return { evaluated: 1, failures: isBad(c[metric]) ? [{ url: c.url, title: `${metric.toUpperCase()} above threshold`, current: `${label(c[metric])} (${c.source})` }] : [] };
}

module.exports = { PAGE_RULES, SITE_RULES };
