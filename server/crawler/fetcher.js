'use strict';
/**
 * HTTP fetcher with manual redirect handling (every hop is re-validated
 * against the SSRF guard), timeouts, response size caps and per-host
 * politeness delay.
 */
const { assertPublicHost } = require('./urlGuard');

const UA = process.env.CRAWLER_USER_AGENT || 'MavlersSEOChecker/1.0 (+https://www.mavlers.com; internal pre-launch QA)';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 8;

class HostThrottle {
  constructor(delayMs) { this.delayMs = delayMs; this.next = new Map(); }
  async wait(host) {
    const now = Date.now();
    const at = Math.max(now, this.next.get(host) || 0);
    this.next.set(host, at + this.delayMs);
    if (at > now) await new Promise(r => setTimeout(r, at - now));
  }
}
const throttle = new HostThrottle(Number(process.env.CRAWL_DELAY_MS || 200));

async function readCapped(res, cap) {
  if (!res.body) return { text: '', bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks = []; let total = 0; let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { truncated = true; try { await reader.cancel(); } catch {} break; }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  return { text: buf.toString('utf8'), bytes: total, truncated };
}

/**
 * Fetch a URL, following redirects manually.
 * @returns {{ url, finalUrl, status, headers, body, bytes, timeMs, chain:[{url,status}], loop, error }}
 */
async function fetchUrl(url, { method = 'GET', timeoutMs = 15000, readBody = true, maxBytes = MAX_BYTES, followRedirects = true } = {}) {
  const chain = [];
  const seen = new Set();
  let current = url;
  const started = Date.now();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u;
    try { u = new URL(current); } catch { return { url, finalUrl: current, status: 0, chain, error: 'Invalid URL' }; }
    if (seen.has(u.href)) return { url, finalUrl: u.href, status: 0, chain, loop: true, error: 'Redirect loop detected' };
    seen.add(u.href);
    try { await assertPublicHost(u); } catch (e) { return { url, finalUrl: u.href, status: 0, chain, error: e.message }; }
    await throttle.wait(u.host);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    const t0 = Date.now();
    try {
      res = await fetch(u.href, {
        method, redirect: 'manual', signal: ctl.signal,
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-encoding': 'gzip, deflate, br' },
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = e.name === 'AbortError' ? `Timed out after ${timeoutMs / 1000}s` : (e.cause && e.cause.code) || e.message;
      return { url, finalUrl: u.href, status: 0, chain, error: msg, timeMs: Date.now() - started };
    }
    const ttfb = Date.now() - t0;
    const headers = Object.fromEntries(res.headers.entries());
    if (res.status >= 300 && res.status < 400 && headers.location && followRedirects) {
      clearTimeout(timer);
      try { await res.body?.cancel(); } catch {}
      chain.push({ url: u.href, status: res.status });
      current = new URL(headers.location, u.href).href;
      continue;
    }
    let body = '', bytes = Number(headers['content-length'] || 0), truncated = false;
    if (readBody && method !== 'HEAD') {
      try { ({ text: body, bytes, truncated } = await readCapped(res, maxBytes)); }
      catch (e) { clearTimeout(timer); return { url, finalUrl: u.href, status: res.status, headers, chain, error: 'Body read failed: ' + e.message }; }
    } else { try { await res.body?.cancel(); } catch {} }
    clearTimeout(timer);
    return { url, finalUrl: u.href, status: res.status, headers, body, bytes, truncated, ttfb, timeMs: Date.now() - started, chain };
  }
  return { url, finalUrl: current, status: 0, chain, error: `More than ${MAX_REDIRECTS} redirects` };
}

/** Lightweight status check: HEAD, falling back to GET when HEAD is refused. */
async function checkStatus(url, opts = {}) {
  let r = await fetchUrl(url, { method: 'HEAD', readBody: false, timeoutMs: opts.timeoutMs || 10000 });
  if (r.status === 405 || r.status === 403 || r.status === 501 || (r.status === 0 && !r.loop && !/private|not allowed/i.test(r.error || ''))) {
    r = await fetchUrl(url, { method: 'GET', readBody: true, maxBytes: 64 * 1024, timeoutMs: opts.timeoutMs || 10000 });
  }
  return r;
}

module.exports = { fetchUrl, checkStatus, UA };
