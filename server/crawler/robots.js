'use strict';
/** Minimal robots.txt parser (groups, Allow/Disallow with * and $ wildcards, Sitemap lines). */

function parseRobots(text) {
  const groups = []; const sitemaps = [];
  let current = null; let lastWasAgent = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'sitemap') { if (val) sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') current.rules.push({ type: key, path: val });
  }
  return { groups, sitemaps };
}

function groupFor(parsed, agent = '*') {
  const a = agent.toLowerCase();
  return parsed.groups.find(g => g.agents.some(x => x !== '*' && a.includes(x))) ||
    parsed.groups.find(g => g.agents.includes('*')) || null;
}

function patternToRegex(p) {
  const anchored = p.endsWith('$');
  const body = anchored ? p.slice(0, -1) : p;
  const esc = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + (anchored ? '$' : ''));
}

/** Longest-match wins, Allow beats Disallow on ties (Google semantics). */
function isAllowed(parsed, urlPath, agent = 'googlebot') {
  const g = groupFor(parsed, agent);
  if (!g) return true;
  let best = null;
  for (const r of g.rules) {
    if (r.type === 'disallow' && r.path === '') continue;
    if (patternToRegex(r.path).test(urlPath)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.type === 'allow')) best = r;
    }
  }
  return !best || best.type === 'allow';
}

function blocksEverything(parsed) {
  const g = groupFor(parsed, 'googlebot');
  return !!g && g.rules.some(r => r.type === 'disallow' && r.path === '/') && !g.rules.some(r => r.type === 'allow' && r.path === '/');
}

module.exports = { parseRobots, isAllowed, blocksEverything };
