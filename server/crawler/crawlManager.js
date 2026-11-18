'use strict';
/**
 * Crawl Manager: owns the lifecycle of an audit.
 *   validate → fetch start URL → robots.txt → sitemap → BFS crawl (bounded)
 *   → link/image/asset status checks → host-variant + 404 checks
 *   → hand off to the SEO engine (rules → scoring → readiness) → persist.
 */
const { normaliseInput, assertPublicHost, siteKey } = require('./urlGuard');
const { fetchUrl, checkStatus } = require('./fetcher');
const { parseRobots, isAllowed, blocksEverything } = require('./robots');
const { discoverSitemaps } = require('./sitemap');
const { parseHtml, STAGING_HOST_RE } = require('./parser');
const { run, get } = require('../db');

// On Vercel a function has a hard time limit, so the crawl stops discovering new pages after this budget
// and goes straight to analysis. 0 = unlimited (self-hosted).
const TIME_BUDGET_MS = Number(process.env.CRAWL_TIME_BUDGET_MS || (process.env.VERCEL ? 200000 : 0));
const STALE_MS = 15 * 60 * 1000;

const live = new Map();         // auditId -> progress object
const cancelled = new Set();

const NON_HTML_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|zip|rar|7z|gz|tar|mp4|mov|avi|webm|mp3|wav|ogg|docx?|xlsx?|pptx?|csv|txt|xml|json|css|js|woff2?|ttf|eot|otf|exe|dmg|apk)$/i;
const CRAWLABLE_PARAMS = /^(page|paged|p|pg)$/i;
const MAX_PAGES_HARD = Number(process.env.MAX_PAGES_HARD || 500);

function normaliseQueueUrl(href) {
  try { const u = new URL(href); u.hash = ''; return u.href; } catch { return null; }
}

function pool(items, concurrency, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await worker(items[idx], idx); }
  });
  return Promise.all(runners);
}

/** Progress lives in the database so any server instance can answer the poll (needed on serverless). */
async function getProgress(auditId) {
  if (live.has(auditId)) return live.get(auditId);
  const row = await get('SELECT progress, status, updated_at, error FROM audits WHERE id = ?', auditId);
  if (!row) return null;
  const prog = { ...(JSON.parse(row.progress || '{}')), status: row.status };
  // A crawl whose worker died (deploy, timeout, crash) stops updating — mark it failed instead of spinning forever.
  if (['queued', 'crawling', 'analysing'].includes(row.status) && row.updated_at && Date.now() - Date.parse(row.updated_at.replace(' ', 'T') + 'Z') > STALE_MS) {
    const msg = 'Audit stopped responding (server timeout or restart) — please re-run';
    await run("UPDATE audits SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?", msg, auditId);
    return { ...prog, status: 'failed', phase: 'Failed', errors: [...(prog.errors || []), msg] };
  }
  return prog;
}

async function cancelAudit(auditId) {
  cancelled.add(Number(auditId));
  await run('UPDATE audits SET cancel_requested = 1 WHERE id = ?', auditId);
}

function makeProgress(auditId) {
  const p = { auditId, phase: 'Starting', status: 'crawling', discovered: 0, analysed: 0, queued: 0, current: null, recent: [], errors: [], startedAt: Date.now(), eta: null, maxPages: 0 };
  let lastSave = 0; let pending = Promise.resolve();
  p.cancelRequested = false;
  p.save = (force = false) => {
    const now = Date.now();
    if (!force && now - lastSave < 1000) return pending;
    lastSave = now;
    const { save, log, err, cancelRequested, ...rest } = p;
    const json = JSON.stringify(rest); const status = p.status;
    pending = pending.then(async () => {
      await run("UPDATE audits SET progress = ?, status = ?, updated_at = datetime('now') WHERE id = ?", json, status, auditId);
      const c = await get('SELECT cancel_requested FROM audits WHERE id = ?', auditId);
      if (c?.cancel_requested) p.cancelRequested = true;
    }).catch(e => console.error('progress save failed', e.message));
    return pending;
  };
  p.log = (url, status, label) => { p.recent.unshift({ url, status, label, at: Date.now() }); p.recent.length = Math.min(p.recent.length, 40); };
  p.err = (msg) => { p.errors.push(msg); if (p.errors.length > 200) p.errors.shift(); };
  live.set(auditId, p);
  return p;
}

const pickHeaders = (h = {}) => ({
  'content-type': h['content-type'] || null, 'cache-control': h['cache-control'] || null, 'content-encoding': h['content-encoding'] || null,
  'x-robots-tag': h['x-robots-tag'] || null, etag: h.etag || null, 'last-modified': h['last-modified'] || null, expires: h.expires || null,
  'strict-transport-security': h['strict-transport-security'] || null, server: undefined,
});

/**
 * Main crawl routine.
 * @returns {{ pages: Map, site: object }}
 */
async function crawl(auditId, rawUrl, options, p) {
  const opts = {
    maxPages: Math.max(1, Math.min(Number(options.maxPages) || 25, MAX_PAGES_HARD)),
    sitemap: options.sitemap !== false, internalLinks: options.internalLinks !== false,
    externalLinks: !!options.externalLinks, images: options.images !== false,
    structuredData: options.structuredData !== false, technical: options.technical !== false,
  };
  p.maxPages = opts.maxPages;
  const startedAt = Date.now();
  const overBudget = () => TIME_BUDGET_MS > 0 && Date.now() - startedAt > TIME_BUDGET_MS;
  const stopped = () => cancelled.has(auditId) || p.cancelRequested;
  const start = normaliseInput(rawUrl);
  await assertPublicHost(start);

  // ---- 1. start URL ----
  p.phase = 'Connecting to website'; p.current = start.href; p.save(true);
  const first = await fetchUrl(start.href);
  if (!first.status) throw new Error(`Could not reach ${start.href}: ${first.error}`);
  const finalStart = new URL(first.finalUrl);
  const origin = finalStart.origin;
  const key = siteKey(finalStart.hostname);
  const site = {
    inputUrl: start.href, startUrl: finalStart.href, origin, host: finalStart.hostname,
    startRedirectChain: first.chain, startStatus: first.status, https: finalStart.protocol === 'https:',
    options: opts, robots: null, sitemap: null, hostChecks: {}, notFound: null, assets: {}, imageSizes: {},
    linkStatus: {}, externalLinkStatus: {}, stagingHost: STAGING_HOST_RE.test(finalStart.hostname), cwv: null,
  };

  // ---- 2. robots.txt ----
  p.phase = 'Reading robots.txt'; p.current = origin + '/robots.txt'; p.save(true);
  const rb = await fetchUrl(origin + '/robots.txt', { timeoutMs: 10000, maxBytes: 512 * 1024 });
  const robotsOk = rb.status === 200 && !/<html/i.test((rb.body || '').slice(0, 500));
  const parsedRobots = parseRobots(robotsOk ? rb.body : '');
  site.robots = {
    url: origin + '/robots.txt', status: rb.status, exists: robotsOk, content: robotsOk ? rb.body.slice(0, 20000) : null,
    sitemaps: parsedRobots.sitemaps, blocksAll: robotsOk && blocksEverything(parsedRobots),
    disallowsAdmin: robotsOk && !isAllowed(parsedRobots, '/wp-admin/'),
  };
  p.log(origin + '/robots.txt', rb.status, 'robots.txt');

  // ---- 3. sitemap ----
  let sitemapUrls = [];
  if (opts.sitemap) {
    p.phase = 'Reading XML sitemap'; p.current = origin + '/sitemap.xml'; p.save(true);
    const sm = await discoverSitemaps(origin, parsedRobots.sitemaps);
    sitemapUrls = sm.urls.filter(u => { try { return siteKey(new URL(u).hostname) === key; } catch { return false; } });
    site.sitemap = { found: sm.found, checked: sm.checked, errors: sm.errors, urlCount: sm.urls.length, offSiteUrls: sm.urls.length - sitemapUrls.length, sample: sm.urls.slice(0, 2000) };
    sm.found.forEach(f => p.log(f.url, 200, 'sitemap'));
  }
  const sitemapSet = new Set(sitemapUrls.map(normaliseQueueUrl));

  // ---- 4. BFS crawl ----
  p.phase = 'Crawling pages';
  const pages = new Map();         // requested url -> record
  const queue = [];
  const queued = new Set();
  const enqueue = (url, depth, from) => {
    const n = normaliseQueueUrl(url);
    if (!n || queued.has(n)) { if (n && from && pages.has(n)) pages.get(n).foundFrom.add(from); return; }
    let u; try { u = new URL(n); } catch { return; }
    if (siteKey(u.hostname) !== key || !['http:', 'https:'].includes(u.protocol)) return;
    if (NON_HTML_EXT.test(u.pathname)) return;
    if ([...u.searchParams.keys()].some(k => !CRAWLABLE_PARAMS.test(k)) && !sitemapSet.has(n)) return;
    queued.add(n);
    queue.push({ url: n, depth, from });
    p.discovered = queued.size;
  };
  enqueue(finalStart.href, 0, null);
  if (start.href !== finalStart.href) queued.add(normaliseQueueUrl(start.href));
  if (opts.sitemap) sitemapUrls.forEach(u => enqueue(u, 1, 'sitemap'));

  let htmlPages = 0; let requests = 0;
  const maxRequests = opts.maxPages * 2 + 10;
  const t0 = Date.now();
  const worker = async () => {
    while (queue.length && htmlPages < opts.maxPages && requests < maxRequests && !overBudget()) {
      if (stopped()) throw new Error('Audit cancelled by user');
      // Prefer shallow pages first (BFS order is preserved by queue order, but sitemap URLs were queued at depth 1).
      const item = queue.shift();
      requests++;
      p.current = item.url; p.queued = queue.length;
      const r = await fetchUrl(item.url);
      const rec = {
        url: item.url, finalUrl: r.finalUrl, status: r.status, depth: item.depth, chain: r.chain || [], loop: !!r.loop,
        ttfb: r.ttfb || null, timeMs: r.timeMs || null, bytes: r.bytes || 0, headers: pickHeaders(r.headers), error: r.error || null,
        inSitemap: sitemapSet.has(item.url), robotsAllowed: isAllowed(parsedRobots, new URL(item.url).pathname + new URL(item.url).search),
        foundFrom: new Set(item.from ? [item.from] : []), data: null, isHtml: false,
      };
      pages.set(item.url, rec);
      if (r.error && !r.status) { p.err(`${item.url} — ${r.error}`); p.log(item.url, 0, 'error'); }
      const ctype = (r.headers && r.headers['content-type']) || '';
      if (r.status >= 200 && r.status < 300 && /html/i.test(ctype)) {
        let data = null;
        try { data = parseHtml(r.body, r.finalUrl, { headers: r.headers }); }
        catch (e) { rec.error = 'HTML parse failed: ' + e.message; p.err(`${item.url} — ${rec.error}`); }
        let holder = rec;
        if (normaliseQueueUrl(r.finalUrl) !== item.url) {
          // Redirected: the requested URL becomes a redirect record, the target holds the page data.
          rec.redirectOnly = true; rec.finalStatus = r.status; rec.status = rec.chain[0]?.status || r.status;
          const tgt = normaliseQueueUrl(r.finalUrl);
          const internalTgt = tgt && siteKey(new URL(tgt).hostname) === key;
          if (internalTgt && !pages.has(tgt)) {
            queued.add(tgt);
            holder = { ...rec, url: tgt, status: r.status, chain: [], redirectOnly: false, foundFrom: new Set([item.url]), inSitemap: sitemapSet.has(tgt), robotsAllowed: isAllowed(parsedRobots, new URL(tgt).pathname) };
            pages.set(tgt, holder);
          } else holder = null;
        }
        if (holder && data) {
          holder.data = data; holder.isHtml = true;
          htmlPages++; p.analysed = htmlPages;
          if (opts.internalLinks) data.internalLinks.forEach(l => enqueue(l.href, item.depth + 1, holder.url));
        }
      } else if (r.status >= 300 && r.status < 400) {
        // redirect loop / too many hops
      } else if (r.status >= 400) {
        p.err(`${item.url} — HTTP ${r.status}`);
      }
      p.log(item.url, rec.status, rec.isHtml ? 'page' : (r.chain?.length ? 'redirect' : ctype.split(';')[0] || 'resource'));
      const elapsed = Date.now() - t0;
      const remaining = Math.min(opts.maxPages - htmlPages, queue.length);
      p.eta = htmlPages ? Math.round((elapsed / htmlPages) * remaining / 1000) : null;
      p.save();
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.CRAWL_CONCURRENCY || 3) }, worker));
  p.queued = queue.length;
  site.crawlLimitReached = htmlPages >= opts.maxPages && queue.length > 0;
  site.uncrawledQueued = queue.length;
  site.timeBudgetReached = overBudget() && queue.length > 0;

  // ---- 5. internal link status for discovered-but-uncrawled URLs + internal resources ----
  p.phase = 'Checking links'; p.save(true);
  const allInternal = new Set(); const allExternal = new Set();
  for (const rec of pages.values()) {
    if (!rec.data) continue;
    rec.data.internalLinks.forEach(l => allInternal.add(normaliseQueueUrl(l.href)));
    rec.data.externalLinks.forEach(l => allExternal.add(normaliseQueueUrl(l.href)));
  }
  const toCheck = [...allInternal].filter(u => u && !pages.has(u)).slice(0, Number(process.env.MAX_INTERNAL_LINK_CHECKS || 150));
  await pool(toCheck, 4, async (u) => {
    if (stopped() || overBudget()) return;
    p.current = u;
    const r = await checkStatus(u);
    site.linkStatus[u] = { status: r.status, finalUrl: r.finalUrl, hops: (r.chain || []).length, loop: !!r.loop, error: r.error || null };
    p.save();
  });
  for (const rec of pages.values()) site.linkStatus[rec.url] = { status: rec.status, finalUrl: rec.finalUrl, hops: rec.chain.length, loop: rec.loop, error: rec.error };

  if (opts.externalLinks) {
    p.phase = 'Checking external links'; p.save(true);
    const ext = [...allExternal].filter(Boolean).slice(0, Number(process.env.MAX_EXTERNAL_LINK_CHECKS || 100));
    await pool(ext, 5, async (u) => {
      if (stopped() || overBudget()) return;
      p.current = u;
      const r = await checkStatus(u, { timeoutMs: 8000 });
      site.externalLinkStatus[u] = { status: r.status, error: r.error || null };
      p.save();
    });
  }

  // ---- 6. image weight checks ----
  if (opts.images) {
    p.phase = 'Analysing images'; p.save(true);
    const imgs = new Set();
    for (const rec of pages.values()) rec.data?.images.forEach(i => imgs.add(i.src));
    const list = [...imgs].filter(s => !/\.svg(\?|$)/i.test(s)).slice(0, Number(process.env.MAX_IMAGE_CHECKS || 80));
    await pool(list, 4, async (src) => {
      if (stopped() || overBudget()) return;
      p.current = src;
      const r = await fetchUrl(src, { method: 'HEAD', readBody: false, timeoutMs: 8000 });
      site.imageSizes[src] = { status: r.status, bytes: Number(r.headers?.['content-length'] || 0) || null, type: r.headers?.['content-type'] || null, cache: r.headers?.['cache-control'] || null };
      p.save();
    });
  }

  // ---- 7. technical site checks ----
  if (opts.technical) {
    p.phase = 'Running technical checks'; p.save(true);
    const hostChecks = {};
    const variants = [];
    const bareHost = finalStart.hostname.replace(/^www\./, '');
    for (const proto of ['http:', 'https:']) for (const h of [bareHost, 'www.' + bareHost]) variants.push(`${proto}//${h}/`);
    await pool(variants, 2, async (v) => {
      const r = await fetchUrl(v, { method: 'GET', maxBytes: 64 * 1024, timeoutMs: 10000 });
      hostChecks[v] = { status: r.status, finalUrl: r.finalUrl, hops: (r.chain || []).length, chain: r.chain, error: r.error || null };
    });
    site.hostChecks = hostChecks;

    const probe = `${origin}/mavlers-seo-check-${Date.now().toString(36)}-not-found`;
    const nf = await fetchUrl(probe, { maxBytes: 256 * 1024 });
    let nfTitle = null; try { nfTitle = parseHtml(nf.body || '', probe).title; } catch {}
    site.notFound = { url: probe, status: nf.status, finalUrl: nf.finalUrl, title: nfTitle, redirectsHome: nf.finalUrl && new URL(nf.finalUrl).pathname === '/' };

    // Asset sampling for caching / minification / compression indicators (homepage assets).
    const home = pages.get(normaliseQueueUrl(finalStart.href));
    site.htmlCompression = home?.headers['content-encoding'] || null;
    site.htmlCacheControl = home?.headers['cache-control'] || null;
    site.hsts = !!(first.headers && first.headers['strict-transport-security']);
    const assets = [...(home?.data?.cssAssets || []).slice(0, 3), ...(home?.data?.jsAssets || []).filter(a => !/googletagmanager|google-analytics|gtag/.test(a)).slice(0, 3)];
    await pool(assets, 3, async (a) => {
      const r = await fetchUrl(a, { maxBytes: 1024 * 1024, timeoutMs: 10000 });
      const body = r.body || '';
      const lines = body.split('\n');
      const avgLine = lines.length ? body.length / lines.length : 0;
      site.assets[a] = {
        status: r.status, bytes: r.bytes, type: /\.css(\?|$)/i.test(a) ? 'css' : 'js',
        cacheControl: r.headers?.['cache-control'] || null, etag: !!r.headers?.etag, encoding: r.headers?.['content-encoding'] || null,
        minified: /\.min\.(css|js)(\?|$)/i.test(a) || (body.length > 2000 ? avgLine > 300 : true),
        sameHost: siteKey(new URL(a).hostname) === key,
      };
    });

    // Optional: Google PageSpeed Insights for Core Web Vitals (requires PAGESPEED_API_KEY).
    if (process.env.PAGESPEED_API_KEY) {
      p.phase = 'Fetching Core Web Vitals (PageSpeed Insights)'; p.save(true);
      try { site.cwv = await fetchPageSpeed(finalStart.href); } catch (e) { site.cwv = { error: e.message }; }
    }
  }

  return { pages, site };
}

async function fetchPageSpeed(url) {
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&url=${encodeURIComponent(url)}&key=${process.env.PAGESPEED_API_KEY}`;
  const res = await fetch(api, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('PageSpeed API HTTP ' + res.status);
  const j = await res.json();
  const field = j.loadingExperience?.metrics || {};
  const lab = j.lighthouseResult?.audits || {};
  return {
    url, source: field.LARGEST_CONTENTFUL_PAINT_MS ? 'field (CrUX)' : 'lab (Lighthouse)',
    lcp: field.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? lab['largest-contentful-paint']?.numericValue ?? null,
    inp: field.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
    cls: field.CUMULATIVE_LAYOUT_SHIFT_SCORE ? field.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 : lab['cumulative-layout-shift']?.numericValue ?? null,
    performanceScore: j.lighthouseResult?.categories?.performance?.score != null ? Math.round(j.lighthouseResult.categories.performance.score * 100) : null,
  };
}

module.exports = { crawl, makeProgress, getProgress, cancelAudit, live, cancelled };
