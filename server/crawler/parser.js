'use strict';
/** HTML → structured page data. Pure function: no network access. */
const cheerio = require('cheerio');
const crypto = require('crypto');
const { siteKey } = require('./urlGuard');

const STAGING_HOST_RE = /(^|\.)(staging|stage|stg|dev|develop|development|test|testing|uat|qa|preprod|pre-prod|sandbox|demo)[.-]|\.(wpengine\.com|wpenginepowered\.com|kinsta\.cloud|pantheonsite\.io|flywheelsites\.com|cloudwaysapps\.com|netlify\.app|vercel\.app|herokuapp\.com|azurewebsites\.net|myshopify\.com|webflow\.io|squarespace\.com|wixsite\.com|ngrok\.io|ngrok-free\.app|localhost)$|^localhost$|project-progress\.net$/i;

function absolutise(href, base) {
  if (!href) return null;
  const h = href.trim();
  if (!h || /^(javascript|mailto|tel|data|sms|whatsapp|skype|ftp):/i.test(h) || h.startsWith('#')) return null;
  try { const u = new URL(h, base); u.hash = ''; return u.href; } catch { return null; }
}

function cleanText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function parseHtml(html, pageUrl, { headers = {} } = {}) {
  const $ = cheerio.load(html || '');
  const base = absolutise($('base[href]').attr('href'), pageUrl) || pageUrl;
  const page = new URL(pageUrl);
  const isHttps = page.protocol === 'https:';
  const host = siteKey(page.hostname);

  const titles = $('head title, title').toArray().map(el => cleanText($(el).text()));
  const title = titles[0] || '';
  const metaDescEls = $('meta[name="description" i]').toArray();
  const metaDescription = cleanText($(metaDescEls[0]).attr('content') || '');
  const metaRobots = $('meta[name="robots" i], meta[name="googlebot" i]').toArray().map(el => ($(el).attr('content') || '').toLowerCase()).join(', ');
  const xRobots = String(headers['x-robots-tag'] || '').toLowerCase();
  const canonicals = $('link[rel="canonical" i]').toArray().map(el => absolutise($(el).attr('href'), base)).filter(Boolean);

  const headings = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => headings.push({ level: Number(el.tagName.slice(1)), text: cleanText($(el).text()).slice(0, 200) }));
  const h1s = headings.filter(h => h.level === 1).map(h => h.text);

  // ---- structured data (JSON-LD + microdata) ----
  const jsonld = []; const schemaTypes = new Set(); const schemaObjects = [];
  $('script[type="application/ld+json" i]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      jsonld.push({ valid: true });
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        if (node['@graph']) walk(node['@graph']);
        if (node['@type']) {
          const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
          types.forEach(t => schemaTypes.add(String(t)));
          schemaObjects.push(node);
        }
        for (const [k, v] of Object.entries(node)) if (k !== '@graph' && v && typeof v === 'object') walk(v);
      };
      walk(parsed);
    } catch (e) { jsonld.push({ valid: false, error: e.message.slice(0, 160), snippet: raw.slice(0, 120) }); }
  });
  $('[itemtype]').each((_, el) => { const t = ($(el).attr('itemtype') || '').split('/').pop(); if (t) schemaTypes.add(t); });

  // ---- content ----
  const $c = cheerio.load($.html());
  $c('script, style, noscript, svg, template, iframe').remove();
  $c('body *').after(' '); // keep words from adjacent elements apart when flattening to text
  let $scope = $c('main').first();
  if (!$scope.length) { $c('header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]').remove(); $scope = $c('body'); }
  const contentText = cleanText($scope.text());
  const words = contentText ? contentText.split(' ').filter(w => /[\p{L}\p{N}]/u.test(w)) : [];
  const paragraphs = $scope.find('p').toArray().map(el => cleanText($c(el).text())).filter(Boolean);
  const longParagraphs = paragraphs.filter(p => p.split(' ').length > 150).length;
  const lists = $scope.find('ul, ol').length;
  const contentHash = words.length > 30 ? crypto.createHash('sha1').update(words.join(' ').toLowerCase()).digest('hex') : null;

  // ---- links ----
  const internal = []; const external = [];
  $('a[href]').each((_, el) => {
    const abs = absolutise($(el).attr('href'), base);
    if (!abs) return;
    const u = new URL(abs);
    if (!['http:', 'https:'].includes(u.protocol)) return;
    const rel = ($(el).attr('rel') || '').toLowerCase();
    const link = { href: abs, text: cleanText($(el).text() || $(el).attr('aria-label') || $(el).find('img').attr('alt') || '').slice(0, 100), nofollow: rel.includes('nofollow'), inNav: $(el).closest('nav, header, [role="navigation"]').length > 0, inFooter: $(el).closest('footer, [role="contentinfo"]').length > 0 };
    (siteKey(u.hostname) === host ? internal : external).push(link);
  });

  // ---- images ----
  const images = [];
  $('img').each((_, el) => {
    const $el = $(el);
    const srcRaw = $el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy-src') || ($el.attr('srcset') || '').split(',')[0].trim().split(' ')[0];
    const src = absolutise(srcRaw, base);
    if (!src) return;
    let filename = '';
    try { filename = decodeURIComponent(new URL(src).pathname.split('/').pop() || ''); } catch {}
    const ext = (filename.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
    const altAttr = $el.attr('alt');
    images.push({
      src, filename, ext,
      alt: altAttr == null ? null : cleanText(altAttr),
      decorative: altAttr === '' || $el.attr('role') === 'presentation' || $el.attr('aria-hidden') === 'true',
      width: $el.attr('width') || null, height: $el.attr('height') || null,
      inPicture: $el.parent().is('picture'),
      pictureWebp: $el.parent().is('picture') && $el.parent().find('source[type="image/webp"], source[type="image/avif"]').length > 0,
      lazy: ($el.attr('loading') || '').toLowerCase() === 'lazy',
    });
  });

  // ---- technical ----
  const mixedContent = [];
  if (isHttps) {
    $('img[src], script[src], iframe[src], audio[src], video[src], source[src], link[rel="stylesheet" i][href]').each((_, el) => {
      const v = $(el).attr('src') || $(el).attr('href');
      if (v && /^http:\/\//i.test(v.trim())) mixedContent.push(v.trim().slice(0, 200));
    });
  }
  const headScripts = $('head script[src]').toArray().filter(el => $(el).attr('async') == null && $(el).attr('defer') == null && ($(el).attr('type') || '').toLowerCase() !== 'module');
  const cssAssets = $('link[rel="stylesheet" i][href]').toArray().map(el => absolutise($(el).attr('href'), base)).filter(Boolean);
  const jsAssets = $('script[src]').toArray().map(el => absolutise($(el).attr('src'), base)).filter(Boolean);

  // ---- tracking / platform detection ----
  const rawHtml = html || '';
  const ga4 = [...new Set([...rawHtml.matchAll(/['"=](G-[A-Z0-9]{6,12})\b/g)].map(m => m[1]))];
  const gtm = [...new Set([...rawHtml.matchAll(/\b(GTM-[A-Z0-9]{4,9})\b/g)].map(m => m[1]))];
  const generator = $('meta[name="generator" i]').toArray().map(el => $(el).attr('content') || '').join(' | ');
  const cms = /wordpress/i.test(generator) || /\/wp-content\//i.test(rawHtml) ? 'WordPress'
    : /shopify/i.test(generator) || /cdn\.shopify\.com/i.test(rawHtml) ? 'Shopify'
    : /wix\.com/i.test(generator) ? 'Wix' : /webflow/i.test(generator) ? 'Webflow' : /squarespace/i.test(generator) ? 'Squarespace' : generator ? generator.split(' ')[0] : null;
  const seoPlugin = /yoast seo/i.test(rawHtml) ? 'Yoast SEO' : /rank math/i.test(rawHtml) ? 'Rank Math' : /all in one seo/i.test(rawHtml) ? 'All in One SEO' : /seopress/i.test(rawHtml) ? 'SEOPress' : null;

  const stagingRefs = new Set();
  $('a[href], link[href], script[src], img[src]').each((_, el) => {
    const v = absolutise($(el).attr('href') || $(el).attr('src'), base);
    if (!v) return;
    try { const h = new URL(v).hostname; if (STAGING_HOST_RE.test(h) && siteKey(h) !== host) stagingRefs.add(new URL(v).origin); } catch {}
  });

  const breadcrumbHtml = $('nav[aria-label*="breadcrumb" i], [class*="breadcrumb" i], [id*="breadcrumb" i], ol[itemtype*="BreadcrumbList"]').length > 0;

  return {
    title, titleLength: title.length, titleCount: titles.length,
    metaDescription, metaLength: metaDescription.length, metaCount: metaDescEls.length,
    metaRobots, xRobots,
    noindex: /noindex|none/.test(metaRobots) || /noindex|none/.test(xRobots),
    nofollow: /nofollow|none/.test(metaRobots) || /nofollow|none/.test(xRobots),
    canonical: canonicals[0] || null, canonicalCount: canonicals.length,
    h1s, headings: headings.slice(0, 150),
    lang: $('html').attr('lang') || null,
    viewport: $('meta[name="viewport" i]').attr('content') || null,
    charset: !!$('meta[charset]').length || /charset=/i.test($('meta[http-equiv="content-type" i]').attr('content') || ''),
    favicon: absolutise($('link[rel~="icon" i]').first().attr('href'), base),
    touchIcon: absolutise($('link[rel="apple-touch-icon" i], link[rel="apple-touch-icon-precomposed" i]').first().attr('href'), base),
    og: { siteName: $('meta[property="og:site_name"]').attr('content') || null, type: $('meta[property="og:type"]').attr('content') || null, title: $('meta[property="og:title"]').attr('content') || null, image: $('meta[property="og:image"]').attr('content') || null },
    wordCount: words.length,
    first100: words.slice(0, 100).join(' '),
    textSample: contentText.slice(0, 1500),
    paragraphCount: paragraphs.length, longParagraphs, lists,
    contentHash,
    internalLinks: internal, externalLinks: external,
    images,
    jsonld, schemaTypes: [...schemaTypes], schemaObjects: schemaObjects.slice(0, 40),
    breadcrumbHtml,
    semantic: { main: $('main, [role="main"]').length, header: $('header').length, nav: $('nav').length, footer: $('footer').length, article: $('article').length, section: $('section').length },
    mixedContent: [...new Set(mixedContent)].slice(0, 25),
    renderBlockingScripts: headScripts.length,
    cssAssets: [...new Set(cssAssets)].slice(0, 30), jsAssets: [...new Set(jsAssets)].slice(0, 40),
    tracking: { ga4, gtm, gscMeta: $('meta[name="google-site-verification" i]').length > 0, uaLegacy: /UA-\d{4,10}-\d+/.test(rawHtml) },
    cms, generator: generator || null, seoPlugin,
    stagingRefs: [...stagingRefs].slice(0, 10),
    questionHeadings: headings.filter(h => h.level >= 2 && /\?\s*$|^(what|how|why|when|where|which|who|can|do|does|is|are|should)\b/i.test(h.text)).length,
  };
}

module.exports = { parseHtml, absolutise, STAGING_HOST_RE };
