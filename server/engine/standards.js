'use strict';
/** Standards Library service: seeds defaults, reads/writes configurable rules, versions changes. */
const { all, get, run, tx, J, getSetting, setSetting } = require('../db');
const { STANDARDS, CATEGORIES, DEFAULT_SETTINGS } = require('./defaultStandards');

async function seed() {
  const existing = new Set((await all('SELECT rule_id FROM standards')).map(r => r.rule_id));
  const missing = STANDARDS.filter(s => !existing.has(s.id));
  if (missing.length) {
    await tx(async (t) => {
      for (const s of missing) await t.run('INSERT INTO standards(rule_id, data, updated_by) VALUES(?, ?, ?) ON CONFLICT(rule_id) DO NOTHING', s.id, JSON.stringify(s), 'system');
    });
  }
  if ((await getSetting('scoring', null)) == null) await setSetting('scoring', DEFAULT_SETTINGS);
  if ((await getSetting('standardsVersion', null)) == null) await setSetting('standardsVersion', 1);
}

async function list() {
  return (await all('SELECT rule_id, data, updated_at, updated_by FROM standards')).map(r => ({ ...J(r.data), updatedAt: r.updated_at, updatedBy: r.updated_by }))
    .sort((a, b) => Object.keys(CATEGORIES).indexOf(a.category) - Object.keys(CATEGORIES).indexOf(b.category));
}

async function byId() { return Object.fromEntries((await list()).map(s => [s.id, s])); }

const EDITABLE = ['name', 'description', 'requirement', 'recommendation', 'why', 'severity', 'enabled', 'threshold', 'pageTypes'];

async function update(ruleId, patch, user = 'unknown') {
  const row = await get('SELECT data FROM standards WHERE rule_id = ?', ruleId);
  if (!row) throw Object.assign(new Error('Standard not found'), { status: 404 });
  const cur = J(row.data);
  const next = { ...cur };
  for (const k of EDITABLE) if (patch[k] !== undefined) next[k] = patch[k];
  if (!['critical', 'warning'].includes(next.severity)) throw Object.assign(new Error('Severity must be critical or warning'), { status: 400 });
  if (typeof next.threshold !== 'object' || Array.isArray(next.threshold)) throw Object.assign(new Error('Threshold must be an object'), { status: 400 });
  next.version = (cur.version || 1) + 1;
  await run("UPDATE standards SET data = ?, updated_at = datetime('now'), updated_by = ? WHERE rule_id = ?", JSON.stringify(next), user, ruleId);
  await bumpVersion();
  return next;
}

async function resetToDefault(ruleId, user) {
  const def = STANDARDS.find(s => s.id === ruleId);
  if (!def) throw Object.assign(new Error('No default for this standard'), { status: 404 });
  const cur = J((await get('SELECT data FROM standards WHERE rule_id = ?', ruleId)).data);
  const next = { ...def, version: (cur.version || 1) + 1 };
  await run("UPDATE standards SET data = ?, updated_at = datetime('now'), updated_by = ? WHERE rule_id = ?", JSON.stringify(next), user, ruleId);
  await bumpVersion();
  return next;
}

async function bumpVersion() { await setSetting('standardsVersion', ((await getSetting('standardsVersion', 1)) || 1) + 1); }
async function version() { return getSetting('standardsVersion', 1); }
async function scoring() { return { ...DEFAULT_SETTINGS, ...(await getSetting('scoring', DEFAULT_SETTINGS)) }; }
async function updateScoring(patch) {
  const cur = await scoring();
  const next = { ...cur, ...patch, weights: { ...cur.weights, ...(patch.weights || {}) }, severityWeights: { ...cur.severityWeights, ...(patch.severityWeights || {}) } };
  for (const v of Object.values(next.weights)) if (typeof v !== 'number' || v < 0) throw Object.assign(new Error('Weights must be non-negative numbers'), { status: 400 });
  await setSetting('scoring', next);
  await bumpVersion();
  return next;
}

module.exports = { seed, list, byId, update, resetToDefault, version, scoring, updateScoring, CATEGORIES };
