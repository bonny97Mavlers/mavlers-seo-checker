'use strict';
/**
 * Analysis pipeline: crawl output → page typing → link graph → rules → issues
 * → weighted scoring → launch readiness → persisted audit.
 */
const { all, get, run, tx, J, insertMany } = require('../db');
const standardsSvc = require('./standards');
const { PAGE_RULES, SITE_RULES } = require('./rules');
const { titleCore, deriveTopic, tokens, jaccard } = require('./text');
const { siteKey } = require('../crawler/urlGuard');
const { CATEGORIES, MANUAL_CHECKLIST } = require('./defaultStandards');

const norm = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };
const pathKey = (u) => { try { const x = new URL(u); return (x.pathname.replace(/\/+$/, '') || '/') + x.search; } catch { return u; } };

function classify(url, data) {
  const u = new URL(url); const p = u.pathname.toLowerCase();
  const types = data?.schemaTypes || [];
  if (p === '/' || p === '' || /^\/(index\.(html?|php))?$/.test(p) || /^\/[a-z]{2}(-[a-z]{2})?\/?$/.test(p)) return 'home';
  if (/(^|\/)(thank-?you|thanks|cart|basket|checkout|my-account|account|login|log-in|signin|sign-in|register|wp-login\.php|search|order-received|wishlist|compare)(\/|$)/.test(p) || u.searchParams.has('s')) return 'utility';
  if (/(privacy|cookie|terms|disclaimer|gdpr|legal|accessibility-statement|refund-policy|shipping-policy)/.test(p)) return 'legal';
  if (/(^|\/)contact(-us)?(\/|$)/.test(p)) return 'contact';
  if (/\/products?\/[^/]+/.test(p) || types.includes('Product') || data?.og?.type === 'product') return 'product';
  if (/\/(product-category|collections?|shop)(\/|$)/.test(p)) return 'product-category';
  if (/\/(category|tag|author)\//.test(p) || /\/(blog|news|insights|articles|resources)\/?$/.test(p) || /\/page\/\d+\/?$/.test(p)) return 'blog-index';
  if (types.some(t => /^(Article|BlogPosting|NewsArticle)$/.test(t)) || data?.og?.type === 'article' || /\/(blog|news|insights|articles|post|posts)\/[^/]+/.test(p) || /\/\d{4}\/\d{2}\/[^/]+/.test(p)) return 'blog-post';
  return 'page';
}

function detectBrand(home, html, configured) {
  if (configured) return configured;
  if (home?.data?.og?.siteName) return home.data.og.siteName;
  const counts = new Map();
  for (const p of html) {
    const m = (p.data.title || '').match(/\s[|\-–—:•·]\s([^|\-–—:•·]{2,40})$/);
    if (m) { const b = m[1].trim(); counts.set(b, (counts.get(b) || 0) + 1); }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= Math.max(2, html.length * 0.4) ? best[0] : '';
}

function applies(std, page) {
  if (std.pageTypes?.length && !std.pageTypes.includes(page.pageType)) return false;
  if (std.appliesTo === 'indexable') return page.indexable && page.pageType !== 'utility';
  return true;
}

function buildContext(pagesMap, site, scoring) {
  const allRecs = [...pagesMap.values()];
  const byUrl = new Map(allRecs.map(r => [norm(r.url), r]));
  const key = siteKey(new URL(site.startUrl).hostname);
  const sameSite = (u) => { try { return siteKey(new URL(u).hostname) === key; } catch { return false; } };
  const html = allRecs.filter(r => r.isHtml && r.data);
  const linkStatus = site.linkStatus || {};

  const homeRec = byUrl.get(norm(site.startUrl)) || html.find(r => new URL(r.url).pathname === '/');
  const brand = detectBrand(homeRec, html, scoring.brandName);

  // resolve a link target through known redirects to the URL that holds page data
  const resolve = (u) => { const n = norm(u); const st = linkStatus[n]; const f = st?.finalUrl ? norm(st.finalUrl) : n; return byUrl.get(f)?.data ? f : (byUrl.get(n)?.data ? n : f); };

  for (const r of html) {
    r.pageType = classify(r.url, r.data);
    r.titleCore = titleCore(r.data.title, brand);
    r.topic = deriveTopic(r.titleCore, r.data.h1s[0] || '');
    const c = r.data.canonical;
    r.canonicalisedTo = c && norm(c) !== norm(r.url) && pathKey(c) !== pathKey(r.url) ? c : null;
    r.indexable = r.status === 200 && !r.data.noindex && r.robotsAllowed && !r.canonicalisedTo;
    r.outlinks = [...new Set(r.data.internalLinks.map(l => resolve(l.href)).filter(u => u !== norm(r.url)))];
    r.inlinks = [];
  }
  const linkTargets = new Map(); // raw internal link target -> Set(source urls)
  for (const r of html) {
    for (const l of r.data.internalLinks) {
      const n = norm(l.href);
      if (!linkTargets.has(n)) linkTargets.set(n, new Set());
      linkTargets.get(n).add(r.url);
    }
    for (const t of r.outlinks) { const tr = byUrl.get(t); if (tr && tr.inlinks && !tr.inlinks.includes(r.url)) tr.inlinks.push(r.url); }
  }
  const indexable = html.filter(r => r.indexable && r.pageType !== 'utility');
  const home = homeRec?.data ? homeRec : html.find(r => r.pageType === 'home');
  const stagingBlocked = site.stagingHost && (!!home?.data?.noindex || !!site.robots?.blocksAll);
  const cms = html.map(r => r.data.cms).find(Boolean) || null;
  const seoPlugin = html.map(r => r.data.seoPlugin).find(Boolean) || null;

  return {
    site, options: site.options, all: allRecs, html, indexable, byUrl, linkStatus, linkTargets, home, brand, brandDisplay: brand,
    norm, sameSite, stagingBlocked, cms, seoPlugin, scoring, cannibalGroups: [],
  };
}

function findCannibalisation(ctx, threshold) {
  const cands = ctx.indexable.filter(p => !['home', 'utility', 'legal', 'contact', 'blog-index'].includes(p.pageType));
  const sig = cands.map(p => {
    const slug = new URL(p.url).pathname.split('/').filter(Boolean).pop() || '';
    return { p, toks: [...new Set([...tokens(p.titleCore), ...tokens(p.data.h1s[0] || ''), ...tokens(slug.replace(/-/g, ' '))])] };
  }).filter(s => s.toks.length >= 2);
  const parent = sig.map((_, i) => i);
  const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const sims = {};
  for (let i = 0; i < sig.length; i++) for (let j = i + 1; j < sig.length; j++) {
    const s = jaccard(sig[i].toks, sig[j].toks);
    if (s >= threshold) { parent[find(i)] = find(j); sims[`${i}-${j}`] = s; }
  }
  const groups = new Map();
  sig.forEach((s, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  return [...groups.values()].filter(g => g.length > 1).map(g => {
    const common = g.map(i => sig[i].toks).reduce((a, b) => a.filter(x => b.includes(x)));
    const simVals = Object.entries(sims).filter(([k]) => { const [a, b] = k.split('-').map(Number); return g.includes(a) && g.includes(b); }).map(([, v]) => v);
    return { pages: g.map(i => sig[i].p.url), topic: (common.length ? common : sig[g[0]].toks).join(' '), similarity: Math.round(Math.max(...simVals) * 100) };
  });
}

/** Run all enabled standards. Returns { issues, ruleResults, pageScores } */
function evaluate(ctx, standards) {
  const issues = []; const ruleResults = []; const sevW = ctx.scoring.severityWeights;
  const pageAcc = new Map(ctx.html.map(p => [p.url, { w: 0, got: 0 }]));
  const canStd = standards['cannibalisation'];
  ctx.cannibalGroups = canStd?.enabled ? findCannibalisation(ctx, canStd.threshold.similarity ?? 0.6) : [];

  for (const std of Object.values(standards)) {
    if (!std.enabled) continue;
    let evaluated = 0, failed = 0;
    const push = (url, f) => {
      issues.push({ rule_id: std.id, severity: f.severity || std.severity, category: std.category, url, title: f.title || std.name, current_value: f.current || null, detail: f.detail || null, source: std.source || 'auto', key: f.key || '' });
    };
    if (std.appliesTo === 'site') {
      const fn = SITE_RULES[std.id]; if (!fn) continue;
      let r; try { r = fn(std, ctx); } catch (e) { console.error('rule failed', std.id, e); continue; }
      if (!r) continue;
      evaluated = r.evaluated; failed = r.failures.length;
      r.failures.forEach(f => push(f.url, f));
      // site-level failures attached to a crawled page lower that page's score too
      for (const f of r.failures) { const acc = pageAcc.get(f.url); if (acc) { acc.w += sevW[f.severity || std.severity] || 1; } }
    } else {
      const fn = PAGE_RULES[std.id]; if (!fn) continue;
      for (const p of ctx.html) {
        if (!applies(std, p)) continue;
        let r; try { r = fn(p, std, ctx); } catch (e) { console.error('rule failed', std.id, p.url, e); continue; }
        if (!r) continue;
        evaluated++;
        const w = sevW[r.severity || std.severity] || 1;
        const acc = pageAcc.get(p.url); acc.w += w;
        if (r.pass) acc.got += w; else { failed++; push(p.url, r); }
      }
    }
    if (evaluated > 0) ruleResults.push({ rule_id: std.id, category: std.category, severity: std.severity, evaluated, failed: Math.min(failed, evaluated) });
  }
  const pageScores = new Map([...pageAcc].map(([u, a]) => [u, a.w ? Math.round((a.got / a.w) * 100) : null]));
  return { issues, ruleResults, pageScores };
}

function computeScores(ruleResults, scoring) {
  const sevW = scoring.severityWeights; const weights = scoring.weights;
  const cats = {};
  for (const r of ruleResults) {
    const c = cats[r.category] || (cats[r.category] = { w: 0, got: 0, rules: 0, failedRules: 0 });
    const w = sevW[r.severity] || 1;
    // Critical failures pull the category down harder: any failure on a critical rule caps that rule's credit at 50%.
    let ratio = 1 - r.failed / r.evaluated;
    if (r.severity === 'critical' && r.failed > 0) ratio = Math.min(ratio, 0.5);
    c.w += w; c.got += w * ratio; c.rules++; if (r.failed) c.failedRules++;
  }
  const categoryScores = {};
  let tw = 0, tot = 0;
  for (const [k, meta] of Object.entries(CATEGORIES)) {
    const c = cats[k];
    if (!c || !c.w) { categoryScores[k] = { label: meta.label, score: null, weight: weights[k] ?? meta.weight, rules: 0 }; continue; }
    const score = Math.round((c.got / c.w) * 100);
    categoryScores[k] = { label: meta.label, score, weight: weights[k] ?? meta.weight, rules: c.rules, failedRules: c.failedRules };
    tw += categoryScores[k].weight; tot += categoryScores[k].weight * score;
  }
  return { score: tw ? Math.round(tot / tw) : 0, categoryScores };
}

/** Readiness depends on *open* issues + manual checklist, so it is recomputed whenever an issue status or checklist item changes. */
async function recomputeReadiness(auditId) {
  const audit = await get('SELECT * FROM audits WHERE id = ?', auditId);
  if (!audit || audit.status !== 'complete') return null;
  const issues = await all('SELECT rule_id, severity, status FROM issues WHERE audit_id = ?', auditId);
  const rr = await all('SELECT * FROM rule_results WHERE audit_id = ?', auditId);
  const scoring = await standardsSvc.scoring(); const sevW = scoring.severityWeights;
  const open = issues.filter(i => i.status === 'open' || i.status === 'in_progress');
  const openCritical = open.filter(i => i.severity === 'critical').length;
  const openWarning = open.filter(i => i.severity === 'warning').length;
  const resolvedPending = issues.filter(i => i.status === 'resolved').length;
  const ignored = issues.filter(i => i.status === 'ignored').length;
  const openByRule = {}; open.forEach(i => { openByRule[i.rule_id] = (openByRule[i.rule_id] || 0) + 1; });
  let w = 0, got = 0;
  for (const r of rr) { const sw = sevW[r.severity] || 1; w += sw * r.evaluated; got += sw * Math.max(0, r.evaluated - Math.min(openByRule[r.rule_id] || 0, r.evaluated)); }
  const pct = w ? Math.round((got / w) * 100) : 0;
  const passedStandards = rr.filter(r => !openByRule[r.rule_id]).length;
  const checklist = await checklistState(auditId);
  const manualPending = checklist.filter(c => !c.done).length;
  const readiness = openCritical > 0 ? 'NOT_READY' : (openWarning > 0 || manualPending > 0) ? 'READY_WITH_WARNINGS' : 'READY';
  const counts = { critical: openCritical, warning: openWarning, passed: passedStandards, standardsEvaluated: rr.length, resolvedPending, ignored, manualPending, totalIssues: issues.length };
  await run('UPDATE audits SET readiness = ?, readiness_pct = ?, counts = ? WHERE id = ?', readiness, pct, JSON.stringify(counts), auditId);
  return { readiness, readinessPct: pct, counts };
}

async function checklistState(auditId) {
  const saved = Object.fromEntries((await all('SELECT * FROM checklist WHERE audit_id = ?', auditId)).map(r => [r.item_key, r]));
  const issues = await all("SELECT rule_id, severity FROM issues WHERE audit_id = ? AND status IN ('open','in_progress')", auditId);
  const evaluatedRules = new Set((await all('SELECT rule_id FROM rule_results WHERE audit_id = ?', auditId)).map(r => r.rule_id));
  return MANUAL_CHECKLIST.map(item => {
    const s = saved[item.key];
    let autoState = null; // 'pass' | 'fail' | null (can't verify automatically)
    if (item.auto === 'critical') autoState = issues.some(i => i.severity === 'critical') ? 'fail' : 'pass';
    else if (Array.isArray(item.auto)) {
      const evald = item.auto.filter(r => evaluatedRules.has(r));
      autoState = !evald.length ? null : issues.some(i => item.auto.includes(i.rule_id)) ? 'fail' : 'pass';
    }
    const manualChecked = !!s?.checked;
    const type = item.manual || autoState === null ? 'manual' : 'auto';
    const done = type === 'auto' ? autoState === 'pass' || manualChecked : manualChecked;
    return { key: item.key, label: item.label, note: item.note || null, type, autoState, manualChecked, done, checkedBy: s?.checked_by || null, checkedAt: s?.checked_at || null };
  });
}

/** Carry statuses/assignees/notes forward from the most recent previous audit of the same project. */
async function carryOver(projectId, auditId, issues) {
  const prev = await get("SELECT id FROM audits WHERE project_id = ? AND id < ? AND status = 'complete' ORDER BY id DESC LIMIT 1", projectId, auditId);
  if (!prev) return;
  const prevIssues = new Map((await all('SELECT fingerprint, status, assignee, notes FROM issues WHERE audit_id = ?', prev.id)).map(i => [i.fingerprint, i]));
  for (const i of issues) {
    const p = prevIssues.get(i.fingerprint); if (!p) continue;
    i.assignee = p.assignee;
    const notes = J(p.notes, []);
    if (p.status === 'ignored') { i.status = 'ignored'; }
    else if (p.status === 'resolved') { notes.push({ by: 'system', at: new Date().toISOString(), text: `Marked resolved in audit #${prev.id}, but still detected in this audit — reopened.` }); }
    else if (p.status === 'in_progress') i.status = 'in_progress';
    i.notes = notes;
  }
}

async function analyseAndPersist(auditId, projectId, pagesMap, site) {
  const standards = await standardsSvc.byId();
  const ctx = buildContext(pagesMap, site, await standardsSvc.scoring());
  const { issues, ruleResults, pageScores } = evaluate(ctx, standards);
  const scoring = ctx.scoring;
  const { score, categoryScores } = computeScores(ruleResults, scoring);
  for (const i of issues) { i.fingerprint = `${i.rule_id}|${pathKey(i.url || '')}|${i.key}`; i.status = 'open'; i.notes = []; }
  // de-duplicate identical fingerprints (same rule/url/key)
  const seen = new Set(); const uniq = issues.filter(i => !seen.has(i.fingerprint) && seen.add(i.fingerprint));
  await carryOver(projectId, auditId, uniq);

  site.brand = ctx.brand; site.cms = ctx.cms; site.seoPlugin = ctx.seoPlugin; site.stagingBlocked = !!ctx.stagingBlocked;
  site.cannibalGroups = ctx.cannibalGroups;
  site.tracking = {
    ga4: [...new Set(ctx.html.flatMap(p => p.data.tracking.ga4))], gtm: [...new Set(ctx.html.flatMap(p => p.data.tracking.gtm))],
    gscMeta: ctx.html.some(p => p.data.tracking.gscMeta),
  };
  const lightSite = { ...site, linkStatus: undefined, sitemap: site.sitemap ? { ...site.sitemap, sample: (site.sitemap.sample || []).slice(0, 300) } : null };

  const pageRows = ctx.all.map(r => {
    const d = r.data ? { ...r.data, schemaObjects: r.data.schemaObjects.slice(0, 15) } : null;
    const extra = { finalUrl: r.finalUrl, chain: r.chain, ttfb: r.ttfb, bytes: r.bytes, headers: r.headers, error: r.error, inSitemap: r.inSitemap, robotsAllowed: r.robotsAllowed, redirectOnly: !!r.redirectOnly, inlinks: r.inlinks || [], outlinks: r.outlinks || [], topic: r.topic || [], canonicalisedTo: r.canonicalisedTo || null, foundFrom: [...(r.foundFrom || [])].slice(0, 20) };
    return [auditId, r.url, r.status, r.depth, r.pageType || (r.isHtml ? 'page' : null), r.indexable ? 1 : 0, pageScores.get(r.url) ?? null, JSON.stringify({ ...extra, page: d })];
  });
  const issueRows = uniq.map(i => [auditId, i.rule_id, i.fingerprint, i.severity, i.category, i.url, i.title, i.current_value, i.detail ? JSON.stringify(i.detail) : null, i.source, i.status, i.assignee || null, JSON.stringify(i.notes || [])]);
  const ruleRows = ruleResults.map(r => [auditId, r.rule_id, r.category, r.severity, r.evaluated, r.failed]);
  const version = await standardsSvc.version();
  await tx(async (t) => {
    await insertMany(t, 'pages', ['audit_id', 'url', 'status_code', 'depth', 'page_type', 'indexable', 'score', 'data'], pageRows, 50);
    await insertMany(t, 'issues', ['audit_id', 'rule_id', 'fingerprint', 'severity', 'category', 'url', 'title', 'current_value', 'detail', 'source', 'status', 'assignee', 'notes'], issueRows, 200);
    await insertMany(t, 'rule_results', ['audit_id', 'rule_id', 'category', 'severity', 'evaluated', 'failed'], ruleRows, 200);
    await t.run("UPDATE audits SET status = 'complete', score = ?, category_scores = ?, standards_version = ?, pages_scanned = ?, site = ?, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      score, JSON.stringify(categoryScores), version, ctx.html.length, JSON.stringify(lightSite), auditId);
  });
  return recomputeReadiness(auditId);
}

module.exports = { analyseAndPersist, recomputeReadiness, checklistState, classify, pathKey };
