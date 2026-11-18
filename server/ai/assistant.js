'use strict';
/**
 * AI SEO Assistant.
 * - Builds a compact, audit-specific context (crawl data, issues, standards, history).
 * - With ANTHROPIC_API_KEY set, answers via the Claude Messages API grounded in that context.
 * - Without a key, a built-in rule-based assistant answers FIND / SUMMARISE / EXPLAIN questions
 *   straight from the audit data and produces template-based suggestions for GENERATE requests.
 * Every answer is labelled so AI output is never presented as verified fact.
 */
const { all, get, J } = require('../db');
const standardsSvc = require('../engine/standards');
const { checklistState } = require('../engine/analyse');
const { CATEGORIES } = require('../engine/defaultStandards');
const { tokens } = require('../engine/text');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const hasLLM = () => !!process.env.ANTHROPIC_API_KEY;
const short = (u) => { try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return u; } };
const READY_LABEL = { READY: 'READY FOR CLIENT DELIVERY', READY_WITH_WARNINGS: 'READY WITH WARNINGS', NOT_READY: 'NOT READY' };

async function loadAudit(auditId) {
  const audit = await get('SELECT * FROM audits WHERE id = ?', auditId);
  if (!audit) throw Object.assign(new Error('Audit not found'), { status: 404 });
  const project = await get('SELECT * FROM projects WHERE id = ?', audit.project_id);
  const pages = (await all('SELECT * FROM pages WHERE audit_id = ?', auditId)).map(p => ({ ...p, data: J(p.data, {}) }));
  const issues = (await all('SELECT * FROM issues WHERE audit_id = ?', auditId)).map(i => ({ ...i, detail: J(i.detail), notes: J(i.notes, []) }));
  return { audit: { ...audit, site: J(audit.site, {}), counts: J(audit.counts, {}), category_scores: J(audit.category_scores, {}) }, project, pages, issues };
}

async function buildContext(auditId) {
  const { audit, project, pages, issues } = await loadAudit(auditId);
  const stds = await standardsSvc.byId();
  const open = issues.filter(i => ['open', 'in_progress'].includes(i.status));
  const byRule = {};
  for (const i of open) {
    const r = byRule[i.rule_id] || (byRule[i.rule_id] = { rule: i.rule_id, standard: stds[i.rule_id]?.name, severity: i.severity, category: i.category, count: 0, examples: [] });
    r.count++; if (r.examples.length < 12) r.examples.push({ id: i.id, url: short(i.url), title: i.title, current: (i.current_value || '').slice(0, 160) });
  }
  const html = pages.filter(p => p.data.page);
  const history = (await all("SELECT id, score, readiness, counts, finished_at, pages_scanned FROM audits WHERE project_id = ? AND status = 'complete' ORDER BY id", audit.project_id))
    .map(a => ({ audit: a.id, date: a.finished_at, score: a.score, readiness: a.readiness, pages: a.pages_scanned, ...J(a.counts, {}) }));
  return {
    project: project.name, website: audit.site.startUrl, auditId: audit.id, auditDate: audit.finished_at,
    seoScore: audit.score, launchReadiness: READY_LABEL[audit.readiness], readinessPct: audit.readiness_pct, counts: audit.counts,
    categoryScores: Object.fromEntries(Object.entries(audit.category_scores).map(([k, v]) => [v.label, v.score])),
    site: { cms: audit.site.cms, seoPlugin: audit.site.seoPlugin, brand: audit.site.brand, https: audit.site.https, robotsTxt: audit.site.robots?.exists, sitemapUrls: audit.site.sitemap?.urlCount ?? null, stagingHost: audit.site.stagingHost, tracking: audit.site.tracking, crawlLimitReached: audit.site.crawlLimitReached, cwv: audit.site.cwv },
    openIssuesByStandard: Object.values(byRule).sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === 'critical' ? -1 : 1)),
    cannibalisation: audit.site.cannibalGroups || [],
    pages: html.slice(0, 150).map(p => ({
      url: short(p.url), type: p.page_type, status: p.status_code, indexable: !!p.indexable, score: p.score,
      title: p.data.page.title, titleLen: p.data.page.titleLength, meta: p.data.page.metaDescription?.slice(0, 170), metaLen: p.data.page.metaLength,
      h1: p.data.page.h1s, words: p.data.page.wordCount, topic: (p.data.topic || []).join(' '), inlinks: p.data.inlinks.length, outlinks: p.data.outlinks.length,
      images: p.data.page.images.length, imagesNoAlt: p.data.page.images.filter(i => i.alt === null && !i.decorative).length, schema: p.data.page.schemaTypes, firstWords: p.data.page.first100?.slice(0, 300),
    })),
    nonHtmlOrErrorUrls: pages.filter(p => !p.data.page).slice(0, 40).map(p => ({ url: short(p.url), status: p.status_code, redirect: p.data.redirectOnly ? short(p.data.finalUrl) : null, error: p.data.error })),
    checklist: (await checklistState(auditId)).map(c => ({ item: c.label, type: c.type, done: c.done })),
    auditHistory: history,
    standards: Object.values(stds).filter(s => s.enabled).map(s => ({ id: s.id, name: s.name, category: CATEGORIES[s.category]?.label, severity: s.severity, requirement: s.requirement, threshold: s.threshold })),
  };
}

const SYSTEM = (ctx) => `You are the Mavlers SEO Pre-Launch Assistant, an internal QA assistant for Mavlers project managers, developers and SEO specialists.
You answer ONLY from the audit data below plus general SEO knowledge needed to explain or fix the findings. Always reference real URLs and findings from the audit. If the data does not contain the answer, say so plainly — never invent pages, numbers or results.
Mavlers standards (in the data) are the source of truth for thresholds and severity. Critical issues block client delivery; warnings should ideally be fixed.
When you generate content (titles, meta descriptions, H1s, alt text, FAQs, internal-link ideas), label it clearly as an AI suggestion that needs human review, respect the standard's thresholds (e.g. title length, meta length, brand suffix "${ctx.site.brand || 'Brand'}"), and base it on the page's actual title/H1/copy.
Things that cannot be confirmed by crawling (Search Console verification, sitemap submission, GA4 events) must be described as "manual verification required".
Write in UK English. Be concise and practical; use short markdown lists and headings where useful. Developer checklists should be grouped by priority (critical first) with the URL for each item.

AUDIT DATA (JSON):
${JSON.stringify(ctx).slice(0, 180000)}`;

async function callClaude(system, messages, maxTokens = 1500) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`AI service error (${res.status}): ${t.slice(0, 300)}`); }
  const j = await res.json();
  return j.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
}

async function ask(auditId, message, history = []) {
  const ctx = await buildContext(auditId);
  if (hasLLM()) {
    const msgs = [...history.slice(-10).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })), { role: 'user', content: message }];
    try { return { answer: await callClaude(SYSTEM(ctx), msgs), source: 'ai', model: MODEL }; }
    catch (e) { const local = await localAnswer(auditId, message); return { ...local, answer: `> ⚠️ The AI service could not be reached (${e.message}). Showing the built-in answer instead.\n\n` + local.answer }; }
  }
  return localAnswer(auditId, message);
}

// ─────────────────────────── built-in (no-LLM) assistant ───────────────────────────
const titleCase = (s) => s.replace(/\b\w/g, c => c.toUpperCase());
function slugWords(u) { const seg = new URL(u).pathname.split('/').filter(Boolean).pop() || ''; return seg.replace(/[-_]+/g, ' ').replace(/\.\w+$/, '').trim(); }

function suggestTitle(page, brand, std) {
  const max = std?.threshold?.max || 60; const min = std?.threshold?.min || 50;
  let core = (page.h1s[0] || page.title.split(/\s[|\-–—]\s/)[0] || '').trim();
  if (!core) core = titleCase(slugWords(page.url || 'https://x/home'));
  const suffix = brand ? ` | ${brand}` : '';
  let t = core + suffix;
  if (t.length > max) { const room = max - suffix.length; core = core.slice(0, room).replace(/\s+\S*$/, ''); t = core + suffix; }
  if (t.length < min) {
    // Don't invent copy: show where a qualifier should go so the content team can complete it.
    const cand = `${core} for [audience / location / benefit]${suffix}`;
    t = cand;
  }
  return t;
}
function suggestMeta(page, std, type) {
  const max = std?.threshold?.max || 160;
  const ctaByType = { contact: 'Get in touch today.', product: 'Order online today.', 'product-category': 'Shop the range today.', 'blog-post': 'Read the full guide.', home: 'Find out more today.' };
  const cta = ctaByType[type] || 'Find out more today.';
  const sentences = (page.textSample || '').split(/(?<=[.!?])\s+/).filter(s => s.length > 30 && s.length < 220);
  const topic = (page.topic || []).join(' ');
  let base = sentences.find(s => topic && s.toLowerCase().includes(page.topic[0])) || sentences[0] || `${page.h1s[0] || page.title}.`;
  base = base.trim().replace(/\s+/g, ' ');
  let m = `${base} ${cta}`;
  if (m.length > max) { const room = max - cta.length - 2; base = base.slice(0, room).replace(/\s+\S*$/, '').replace(/[,;:]$/, '') + '.'; m = `${base} ${cta}`; }
  if (m.length < (std?.threshold?.min || 150)) m += ' [Page copy is thin — expand this description manually to reach the target length.]';
  return m;
}
function suggestAlt(src) {
  let f = decodeURIComponent((src.split('/').pop() || '').split('?')[0]).replace(/\.\w+$/, '');
  f = f.replace(/[-_]+/g, ' ').replace(/\b\d{2,4}x\d{2,4}\b/g, '').replace(/\b(scaled|copy|final|v\d+|img|dsc|image|photo)\b/gi, '').replace(/\d{3,}/g, '').replace(/\s+/g, ' ').trim();
  return f.length > 3 ? f.charAt(0).toUpperCase() + f.slice(1) : '(describe what the image shows — the filename gives no clue)';
}

function findPage(pages, message) {
  const html = pages.filter(p => p.data.page);
  const m = message.toLowerCase();
  const urlMatch = message.match(/https?:\/\/\S+|(?:^|\s)(\/[a-z0-9\-_/.?=&%]*)/i);
  if (urlMatch) {
    const needle = (urlMatch[0].trim()).replace(/[.,!?)]+$/, '');
    const hit = html.find(p => p.url === needle || short(p.url) === needle || short(p.url).replace(/\/$/, '') === needle.replace(/\/$/, ''));
    if (hit) return hit;
  }
  if (/\bhome ?page\b|\bhome\b/.test(m)) return html.find(p => p.page_type === 'home');
  let best = null, bestScore = 0;
  for (const p of html) {
    const words = slugWords(p.url).toLowerCase().split(' ').filter(w => w.length > 2 && !['page', 'pages', 'the', 'and', 'for'].includes(w));
    const score = words.filter(w => m.includes(w)).length;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

function issueList(issues, max = 25) {
  if (!issues.length) return '_None found._';
  const lines = issues.slice(0, max).map(i => `- ${i.severity === 'critical' ? '🔴' : '🟠'} **${short(i.url)}** — ${i.title}${i.current_value ? ` · ${i.current_value.slice(0, 140)}` : ''}`);
  if (issues.length > max) lines.push(`- …and ${issues.length - max} more (see the Issues screen).`);
  return lines.join('\n');
}

async function localAnswer(auditId, message) {
  const { audit, pages, issues } = await loadAudit(auditId);
  const stds = await standardsSvc.byId();
  const m = message.toLowerCase();
  const open = issues.filter(i => ['open', 'in_progress'].includes(i.status));
  const of = (...rules) => open.filter(i => rules.includes(i.rule_id));
  const brand = audit.site.brand || '';
  const c = audit.counts;
  const generate = /\b(suggest|write|generate|create|draft|improve|better|rewrite|propose)\b/.test(m) && !/checklist|summary|summar/.test(m);
  const out = (answer, source = 'audit') => ({ answer, source });

  // ---- GENERATE ----
  if (generate && /\balt\b/.test(m)) {
    const page = findPage(pages, message);
    const targets = (page ? [page] : pages.filter(p => p.data.page)).flatMap(p => p.data.page.images.filter(i => i.alt === null && !i.decorative).map(i => ({ p, i }))).slice(0, 20);
    if (!targets.length) return out('No images with missing alt text were found' + (page ? ` on **${short(page.url)}**.` : '.'));
    return out(`### Suggested alt text (template — review before use)\n` + targets.map(({ p, i }) => `- **${i.filename}** on ${short(p.url)} → "${suggestAlt(i.src)}"`).join('\n') +
      `\n\n_These are generated from filenames only. Describe what each image actually shows in context; connect the AI service for content-aware suggestions._`, 'template');
  }
  if (generate && /\bmeta\b|description/.test(m)) {
    const page = findPage(pages, message) || pages.find(p => p.page_type === 'home');
    if (!page?.data.page) return out('Tell me which page (e.g. "/services") and I will draft a meta description.');
    const s = suggestMeta({ ...page.data.page, topic: page.data.topic }, stds['meta-length'], page.page_type);
    return out(`### Suggested meta description for ${short(page.url)}\n**Current:** ${page.data.page.metaDescription ? `"${page.data.page.metaDescription}" (${page.data.page.metaLength} chars)` : '_none_'}\n\n**Suggestion (${s.length} chars):**\n> ${s}\n\n_Template suggestion built from the page copy — edit for tone and accuracy. Target: ${stds['meta-length'].threshold.min}–${stds['meta-length'].threshold.max} characters with a call to action._`, 'template');
  }
  if (generate && /\bh1\b/.test(m)) {
    const page = findPage(pages, message) || pages.find(p => p.page_type === 'home');
    if (!page?.data.page) return out('Tell me which page and I will suggest an H1.');
    const core = (page.data.page.title.split(/\s[|\-–—]\s/)[0] || titleCase(slugWords(page.url))).trim();
    return out(`### Suggested H1 for ${short(page.url)}\n**Current:** ${page.data.page.h1s.length ? page.data.page.h1s.map(h => `"${h}"`).join(', ') : '_none_'}\n\n**Suggestion:** "${core}"\n\n_Template suggestion based on the title — make sure it states the page's primary topic in natural language._`, 'template');
  }
  if (generate && /\btitle\b/.test(m)) {
    const page = findPage(pages, message) || pages.find(p => p.page_type === 'home');
    if (!page?.data.page) return out('Tell me which page and I will suggest a title.');
    const s = suggestTitle({ ...page.data.page, url: page.url, topic: page.data.topic }, brand, stds['title-length']);
    const tl = stds['title-length'].threshold; const curLen = page.data.page.titleLength;
    if (s === page.data.page.title) return out(`### ${short(page.url)}\nThe current title "${page.data.page.title}" (${curLen} chars) ${curLen >= tl.min && curLen <= tl.max ? 'already meets the standard' : "couldn't be improved automatically from the page copy"}. Connect the AI service for creative alternatives.`, 'template');
    return out(`### Suggested title for ${short(page.url)}\n**Current:** "${page.data.page.title || '(none)'}" (${page.data.page.titleLength} chars)\n\n**Suggestion (${s.length} chars):** "${s}"\n\n_Template suggestion — lead with the primary keyword and keep ${stds['title-length'].threshold.min}–${stds['title-length'].threshold.max} characters including the brand suffix._`, 'template');
  }
  if (generate && /faq/.test(m)) {
    const page = findPage(pages, message) || pages.find(p => p.page_type === 'home');
    const topic = page?.data.topic?.join(' ') || 'this service';
    return out(`### FAQ question ideas for ${page ? short(page.url) : 'the site'} (template)\n- What is ${topic}?\n- How much does ${topic} cost?\n- How long does ${topic} take?\n- Why choose ${brand || 'us'} for ${topic}?\n- What do I need to get started?\n\n_Generic starters — connect the AI service to generate questions and answers from the page content. Mark up the final FAQ with FAQPage schema._`, 'template');
  }
  if (generate && /internal link/.test(m)) {
    const weak = pages.filter(p => p.data.page && p.indexable && p.data.inlinks.length <= 1).slice(0, 10);
    return out(`### Internal linking opportunities\n${weak.length ? weak.map(p => `- **${short(p.url)}** has ${p.data.inlinks.length} inbound link(s). Link to it from related pages about "${(p.data.topic || []).join(' ')}".`).join('\n') : '_No weakly linked pages found._'}`, 'template');
  }

  // ---- FIND ----
  if (/duplicate/.test(m) && /title/.test(m)) return out(`### Duplicate titles\n${dupGroups(of('title-duplicate'))}`);
  if (/duplicate/.test(m) && /(meta|description)/.test(m)) return out(`### Duplicate meta descriptions\n${dupGroups(of('meta-duplicate'))}`);
  if (/duplicate/.test(m) && /h1/.test(m)) return out(`### Duplicate H1s\n${dupGroups(of('h1-duplicate'))}`);
  if (/\bh1/.test(m)) return out(`### H1 issues\n${issueList(of('h1-missing', 'h1-multiple', 'h1-empty', 'h1-duplicate'))}`);
  if (/meta/.test(m) && /(missing|without|no )/.test(m)) return out(`### Pages missing a meta description\n${issueList(of('meta-missing'))}`);
  if (/meta|description/.test(m)) return out(`### Meta description issues\n${issueList(of('meta-missing', 'meta-length', 'meta-duplicate', 'meta-cta'))}`);
  if (/title/.test(m) && !/ready/.test(m)) return out(`### Title tag issues\n${issueList(of('title-missing', 'title-length', 'title-duplicate', 'title-brand-suffix', 'h1-title-relevance'))}`);
  if (/orphan/.test(m)) return out(`### Orphan pages\n${issueList(of('orphan-pages'))}\n\nThese pages have no internal links pointing to them from the crawled pages${of('orphan-pages').some(i => /sitemap/i.test(i.current_value || '')) ? ' (some are only reachable via the XML sitemap)' : ''}.`);
  if (/broken|404|dead link/.test(m)) return out(`### Broken links\n${issueList(of('broken-internal-links', 'broken-external-links', 'page-errors'))}`);
  if (/\balt\b|image/.test(m)) return out(`### Image issues\n${issueList(of('img-alt-missing', 'img-alt-generic', 'img-filename', 'img-format', 'img-dimensions', 'img-oversized'))}`);
  if (/canonical/.test(m)) return out(`### Canonical issues\n${issueList(of('canonical-missing', 'canonical-target', 'host-canonicalisation'))}`);
  if (/schema|structured data/.test(m)) return out(`### Structured data issues\n${issueList(of('schema-valid', 'schema-website', 'schema-breadcrumb', 'schema-article', 'schema-product', 'schema-faq', 'structured-data-present'))}`);
  if (/cannibal/.test(m)) {
    const g = audit.site.cannibalGroups || [];
    if (!g.length) return out('No potential keyword cannibalisation was detected among the crawled indexable pages.');
    return out(`### Potential keyword cannibalisation\n` + g.map(x => `- **${x.pages.map(short).join(' · ')}**\n  These pages share the core terms **"${x.topic}"** across their titles, H1s and URLs (similarity ${x.similarity}%). Review whether each has a distinct search intent; merge, differentiate or canonicalise.`).join('\n') + `\n\n_Heuristic: based on overlapping title/H1/slug terms, not ranking data._`);
  }
  if (/staging/.test(m)) return out(`### Staging checks\n${issueList(of('staging-detected'))}`);
  if (/redirect/.test(m)) return out(`### Redirect issues\n${issueList(of('redirect-chains', 'internal-redirect-links', 'host-canonicalisation'))}`);
  if (/robots|sitemap|index/.test(m) && !/ready/.test(m)) return out(`### Indexing & crawlability issues\n${issueList(open.filter(i => i.category === 'indexing'))}`);

  // ---- SUMMARISE / EXPLAIN ----
  if (/why/.test(m) && (/home ?page/.test(m) || /fail/.test(m))) {
    const page = findPage(pages, message) || pages.find(p => p.page_type === 'home');
    const pi = open.filter(i => i.url === page?.url || (i.detail?.urls || []).includes(page?.url));
    return out(`### ${short(page.url)} — score ${page.score ?? '–'}/100\n${pi.length ? issueList(sortIssues(pi)) : 'No open issues are attached to this page.'}`);
  }
  if (/\btop\b|most important|priorit|\d+ (most|biggest)/.test(m)) return out(topIssues(open, stds));
  if (/ready|deliver|launch|go live|go-live/.test(m)) return out(readinessText(audit, open));
  if (/developer|dev /.test(m) && /checklist|fix/.test(m) || /fix first|what should .*fix/.test(m)) return out(devChecklist(open, stds));
  if (/\bpm\b|project manager/.test(m)) return out(pmChecklist(audit, open, await checklistState(auditId)));
  if (/client/.test(m)) return out(clientSummary(audit));
  if (/top|most important|priorit|before launch|first/.test(m)) return out(topIssues(open, stds));
  if (/summary|summar|overview/.test(m)) return out(fullSummary(audit, open, stds));
  if (/explain|what does|what is|mean/.test(m)) {
    const words = m.split(/\W+/).filter(w => w.length > 3);
    const std = Object.values(stds).map(s => ({ s, score: words.filter(w => (s.name + ' ' + s.id).toLowerCase().includes(w)).length })).sort((a, b) => b.score - a.score)[0];
    if (std && std.score) return out(`### ${std.s.name}\n**Why it matters:** ${std.s.why}\n\n**Mavlers standard:** ${std.s.requirement}\n\n**How to fix:** ${std.s.recommendation}\n\n**Blocks launch?** ${std.s.severity === 'critical' ? 'Yes — this is a critical standard.' : 'No — it is a warning, but should ideally be fixed before delivery.'}`);
  }

  return out(`I answer from this audit's data. Right now **${audit.site.startUrl}** scores **${audit.score}/100** and is **${READY_LABEL[audit.readiness]}** (${c.critical} critical, ${c.warning} warnings).\n\nTry asking:\n- What are the 5 most important issues before launch?\n- Which pages have missing meta descriptions?\n- Show me all duplicate titles\n- Which pages are orphaned?\n- Suggest a better title for /about\n- Create a developer fix checklist\n- Is this website ready for client delivery?\n\n_The built-in assistant handles audit questions and template suggestions. Set ANTHROPIC_API_KEY on the server for free-form questions and content-aware suggestions._`);
}

function sortIssues(list) { return [...list].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1)); }
function dupGroups(list) {
  if (!list.length) return '_No duplicates found._';
  const groups = new Map();
  for (const i of list) { const k = i.detail?.value || i.current_value; if (!groups.has(k)) groups.set(k, new Set()); groups.get(k).add(short(i.url)); }
  return [...groups].map(([v, urls]) => `- **"${String(v).slice(0, 120)}"** — ${[...urls].join(', ')}`).join('\n');
}
function groupByRule(open, stds) {
  const g = {};
  for (const i of open) (g[i.rule_id] ||= { std: stds[i.rule_id], items: [] }).items.push(i);
  return Object.values(g).sort((a, b) => (a.items[0].severity === b.items[0].severity ? b.items.length - a.items.length : a.items[0].severity === 'critical' ? -1 : 1));
}
function topIssues(open, stds) {
  const g = groupByRule(open, stds).slice(0, 5);
  if (!g.length) return 'There are no open issues — nothing blocking launch.';
  return `### Top ${g.length} issues to fix before launch\n` + g.map((x, n) => `${n + 1}. ${x.items[0].severity === 'critical' ? '🔴' : '🟠'} **${x.std?.name || x.items[0].title}** — ${x.items.length} URL${x.items.length > 1 ? 's' : ''} (e.g. ${[...new Set(x.items.map(i => short(i.url)))].slice(0, 3).join(', ')})\n   _Fix:_ ${x.std?.recommendation || ''}`).join('\n');
}
function devChecklist(open, stds) {
  const g = groupByRule(open.filter(i => !['meta-cta', 'keyword-first-100', 'keyword-meta', 'qa-headings'].includes(i.rule_id) || i.severity === 'critical'), stds);
  if (!g.length) return 'No open developer issues. 🎉';
  const crit = g.filter(x => x.items[0].severity === 'critical'); const warn = g.filter(x => x.items[0].severity !== 'critical');
  const block = (arr) => arr.map(x => `- [ ] **${x.std?.name}** (${x.items.length}) — ${x.std?.recommendation}\n${x.items.slice(0, 8).map(i => `  - ${short(i.url)}${i.current_value ? ` · ${i.current_value.slice(0, 100)}` : ''}`).join('\n')}${x.items.length > 8 ? `\n  - …+${x.items.length - 8} more` : ''}`).join('\n');
  return `## Developer fix checklist\n### 1. Critical — fix before delivery\n${crit.length ? block(crit) : '_None._'}\n\n### 2. Warnings — fix where possible\n${warn.length ? block(warn) : '_None._'}\n\nRe-run the audit after fixes to verify.`;
}
function pmChecklist(audit, open, cl) {
  return `## PM pre-delivery checklist — ${audit.site.startUrl}\n**Status:** ${READY_LABEL[audit.readiness]} · **Score:** ${audit.score}/100\n\n` +
    cl.map(c => `- [${c.done ? 'x' : ' '}] ${c.label} ${c.type === 'manual' ? '_(manual verification required)_' : c.autoState === 'fail' ? '— ⚠️ open issues' : '— ✓ auto-verified'}`).join('\n') +
    `\n\n**Open:** ${open.filter(i => i.severity === 'critical').length} critical, ${open.filter(i => i.severity === 'warning').length} warnings.`;
}
function readinessText(audit, open) {
  const crit = open.filter(i => i.severity === 'critical');
  const c = audit.counts;
  let s = `## ${READY_LABEL[audit.readiness]}\nScore **${audit.score}/100** · readiness **${audit.readiness_pct}%** · ${c.critical} critical · ${c.warning} warnings · ${c.passed}/${c.standardsEvaluated} standards met.\n\n`;
  if (audit.readiness === 'NOT_READY') s += `**Why it is not ready:** ${crit.length} critical issue${crit.length > 1 ? 's' : ''} remain:\n${issueList(sortIssues(crit), 10)}`;
  else if (audit.readiness === 'READY_WITH_WARNINGS') s += `**Why:** no critical issues remain, but ${c.warning} warning${c.warning === 1 ? '' : 's'} are open${c.manualPending ? ` and ${c.manualPending} checklist item(s) still need manual confirmation` : ''}. Delivery is possible; agree any outstanding warnings with the client.`;
  else s += '**Why it is ready:** no critical or warning issues remain and the pre-delivery checklist is complete.';
  if (c.resolvedPending) s += `\n\n_${c.resolvedPending} issue(s) are marked resolved but not yet verified — re-run the audit to confirm._`;
  return s;
}
function clientSummary(audit) {
  const cats = Object.values(audit.category_scores).filter(c => c.score != null);
  return `## SEO launch summary — ${audit.site.startUrl}\nWe have completed our on-page SEO quality check (${audit.pages_scanned} pages reviewed).\n\n**Overall SEO health:** ${audit.score}/100\n\n${cats.map(c => `- ${c.label}: ${c.score}%`).join('\n')}\n\n**Status:** ${READY_LABEL[audit.readiness]}.\n\nTitles, meta descriptions, headings, indexing settings, sitemap, structured data and technical basics have been checked against the Mavlers build standard.`;
}
function fullSummary(audit, open, stds) {
  return `## Final SEO QA summary\n**Website:** ${audit.site.startUrl} · **Pages analysed:** ${audit.pages_scanned} · **Score:** ${audit.score}/100 · **${READY_LABEL[audit.readiness]}**\n\n### Category scores\n${Object.values(audit.category_scores).filter(c => c.score != null).map(c => `- ${c.label}: ${c.score}%`).join('\n')}\n\n${topIssues(open, stds)}\n\n### Platform\n- CMS: ${audit.site.cms || 'not detected'}${audit.site.seoPlugin ? ` · ${audit.site.seoPlugin}` : ''}\n- Tracking: ${[...(audit.site.tracking?.ga4 || []), ...(audit.site.tracking?.gtm || [])].join(', ') || 'none detected'} _(confirm data flow manually)_`;
}

async function suggestFix(issueId) {
  const issue = await get('SELECT * FROM issues WHERE id = ?', issueId);
  if (!issue) throw Object.assign(new Error('Issue not found'), { status: 404 });
  const page = await get('SELECT * FROM pages WHERE audit_id = ? AND url = ?', issue.audit_id, issue.url);
  const pd = page ? J(page.data, {}) : {};
  const audit = await get('SELECT site FROM audits WHERE id = ?', issue.audit_id);
  const site = J(audit.site, {});
  const stdMap = await standardsSvc.byId();
  const std = stdMap[issue.rule_id];
  if (hasLLM()) {
    const prompt = `Issue: ${issue.title}\nStandard: ${std?.name} — ${std?.requirement} (threshold ${JSON.stringify(std?.threshold)})\nURL: ${issue.url}\nCurrent: ${issue.current_value}\nDetail: ${issue.detail || ''}\nPage title: ${pd.page?.title}\nH1: ${(pd.page?.h1s || []).join(' / ')}\nMeta: ${pd.page?.metaDescription}\nOpening copy: ${pd.page?.first100}\nBrand: ${site.brand}\n\nGive a concrete suggested fix. If the fix is content (title/meta/H1/alt text), give 1–3 ready-to-paste options that meet the standard, with character counts. If it is technical, give exact steps/code. Keep it under 180 words. Markdown.`;
    try { return { suggestion: await callClaude('You are the Mavlers SEO Pre-Launch Assistant. Suggestions must meet the given Mavlers standard. UK English.', [{ role: 'user', content: prompt }], 700), source: 'ai', model: MODEL }; }
    catch (e) { /* fall through to template */ }
  }
  const p = pd.page ? { ...pd.page, url: issue.url, topic: pd.topic } : null;
  let s;
  switch (issue.rule_id) {
    case 'title-missing': case 'title-length': case 'title-brand-suffix': case 'title-duplicate': case 'h1-title-relevance':
      s = p ? `Suggested title (${suggestTitle(p, site.brand, stdMap['title-length']).length} chars):\n\n> ${suggestTitle(p, site.brand, stdMap['title-length'])}` : null; break;
    case 'meta-missing': case 'meta-length': case 'meta-duplicate': case 'meta-cta': case 'keyword-meta': {
      const m = p && suggestMeta(p, stdMap['meta-length'], page.page_type); s = m ? `Suggested meta description (${m.length} chars):\n\n> ${m}` : null; break; }
    case 'h1-missing': case 'h1-empty': case 'h1-multiple': case 'h1-duplicate':
      s = p ? `Suggested H1:\n\n> ${(p.title.split(/\s[|\-–—]\s/)[0] || '').trim() || titleCase(slugWords(issue.url))}` + (issue.rule_id === 'h1-multiple' ? '\n\nKeep this as the only H1 and change the others to H2/H3.' : '') : null; break;
    case 'img-alt-missing': case 'img-alt-generic': {
      const imgs = (J(issue.detail, {}).images || []).slice(0, 8).map(x => typeof x === 'string' ? x : x.src);
      s = imgs.length ? 'Suggested alt text (from filenames — check against the actual images):\n\n' + imgs.map(src => `- \`${src.split('/').pop()}\` → "${suggestAlt(src)}"`).join('\n') : null; break; }
    case 'canonical-missing': s = `Add to <head>:\n\n\`\`\`html\n<link rel="canonical" href="${issue.url}">\n\`\`\``; break;
    case 'viewport': s = '```html\n<meta name="viewport" content="width=device-width, initial-scale=1">\n```'; break;
    case 'lang': s = '```html\n<html lang="en-GB">\n```'; break;
    case 'schema-breadcrumb': s = 'Example BreadcrumbList JSON-LD:\n\n```html\n<script type="application/ld+json">\n' + JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: new URL(issue.url).origin + '/' }, { '@type': 'ListItem', position: 2, name: p?.h1s?.[0] || titleCase(slugWords(issue.url)), item: issue.url }] }, null, 2) + '\n</script>\n```'; break;
    case 'schema-website': s = '```html\n<script type="application/ld+json">\n' + JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: site.brand || 'Brand', url: site.origin + '/' }, null, 2) + '\n</script>\n```'; break;
    default: s = null;
  }
  return { suggestion: s || `**Recommended fix:** ${std?.recommendation || 'See the Mavlers standard.'}`, source: s ? 'template' : 'standard' };
}

module.exports = { ask, suggestFix, buildContext, hasLLM, MODEL };
