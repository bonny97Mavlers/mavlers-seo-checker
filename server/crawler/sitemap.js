'use strict';
/** XML sitemap discovery + parsing (sitemap index files are followed, capped). */
const cheerio = require('cheerio');
const { fetchUrl } = require('./fetcher');

const MAX_SITEMAPS = 15;
const MAX_URLS = 5000;

async function discoverSitemaps(origin, robotsSitemaps = []) {
  const candidates = [...robotsSitemaps];
  for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml']) candidates.push(origin + p);
  const result = { found: [], urls: [], errors: [], checked: [] };
  const queue = [...new Set(candidates)];
  const seen = new Set();
  while (queue.length && seen.size < MAX_SITEMAPS && result.urls.length < MAX_URLS) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    const r = await fetchUrl(sm, { timeoutMs: 15000, maxBytes: 10 * 1024 * 1024 });
    result.checked.push({ url: sm, status: r.status, finalUrl: r.finalUrl, error: r.error || null });
    if (r.status !== 200 || !r.body || !/<(urlset|sitemapindex)\b/i.test(r.body)) {
      // Only report as an error if it was explicitly declared (robots.txt) — guessed paths are allowed to 404.
      if (robotsSitemaps.includes(sm)) result.errors.push(`${sm} → ${r.error || 'HTTP ' + r.status}`);
      continue;
    }
    // Once a real sitemap is found, stop guessing other default paths.
    if (!result.found.length) {
      for (let i = queue.length - 1; i >= 0; i--) if (!robotsSitemaps.includes(queue[i]) && /\/(sitemap|sitemap_index|wp-sitemap)\.xml$/.test(queue[i])) queue.splice(i, 1);
    }
    const $ = cheerio.load(r.body, { xmlMode: true });
    const isIndex = $('sitemapindex').length > 0;
    result.found.push({ url: sm, type: isIndex ? 'index' : 'urlset' });
    if (isIndex) {
      $('sitemap > loc').each((_, el) => { const loc = $(el).text().trim(); if (loc) queue.push(loc); });
    } else {
      $('url > loc').each((_, el) => {
        if (result.urls.length >= MAX_URLS) return false;
        const loc = $(el).text().trim(); if (loc) result.urls.push(loc);
      });
    }
  }
  result.urls = [...new Set(result.urls)];
  return result;
}

module.exports = { discoverSitemaps };
