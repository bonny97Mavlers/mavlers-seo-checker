'use strict';
/** Small text utilities for topic/intent heuristics (no external NLP dependency). */

const STOP = new Set(('a an and are as at be by for from has have how i in is it its of on or our that the this to was we what when where which who why will with you your us me my they them their into over under than then so do does can just more most also not no yes all any each get got home page welcome official site best top new ' +
  'services service').split(' '));

function stem(w) {
  if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es') && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokens(text, { keepStop = false } = {}) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length > 1 && (keepStop || !STOP.has(w))).map(stem);
}

/** Strip a trailing " | Brand" style suffix from a title. */
function titleCore(title, brand) {
  let t = String(title || '');
  const m = t.match(/^(.*?)\s+[|\-–—:•·]\s+[^|\-–—:•·]{1,40}$/);
  if (m && m[1].length > 3) t = m[1];
  if (brand) t = t.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '');
  return t.trim();
}

/** Primary topic = meaningful words shared by the H1 and title (falls back to H1, then title). Max 4 tokens. */
function deriveTopic(titleC, h1) {
  const ht = tokens(h1); const tt = tokens(titleC);
  const tset = new Set(tt);
  let topic = ht.filter(x => tset.has(x));
  if (!topic.length) topic = ht.length ? ht : tt;
  return [...new Set(topic)].slice(0, 4);
}

function topicCoverage(topic, text) {
  if (!topic.length) return 1;
  const set = new Set(tokens(text, { keepStop: true }));
  return topic.filter(t => set.has(t)).length / topic.length;
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

module.exports = { tokens, titleCore, deriveTopic, topicCoverage, jaccard, STOP };
