'use strict';
/**
 * End-to-end smoke test: boots the fixture site + the app (temp database), runs an audit,
 * and asserts the planted defects are detected.  Run: npm test
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const APP = 4391, FX = 4491;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-smoke-'));
const env = { ...process.env, PORT: APP, FIXTURE_PORT: FX, DATA_DIR: dataDir, ALLOW_PRIVATE_HOSTS: 'true', CRAWL_DELAY_MS: '10' };
const procs = [spawn('node', [path.join(__dirname, 'test-site.js')], { env }), spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], { env })];
const stop = (code) => { procs.forEach(p => p.kill()); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(code); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const j = async (u, o) => (await fetch(`http://localhost:${APP}${u}`, o)).json();

(async () => {
  await sleep(1200);
  const { auditId } = await j('/api/audits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `http://localhost:${FX}`, options: { maxPages: 50 } }) });
  let a;
  for (let i = 0; i < 60; i++) { a = await j(`/api/audits/${auditId}`); if (['complete', 'failed'].includes(a.status)) break; await sleep(500); }
  if (a.status !== 'complete') { console.error('Audit did not complete:', a.error); return stop(1); }
  const issues = await j(`/api/audits/${auditId}/issues?status=`);
  const has = (rule, pathPart) => issues.some(i => i.rule_id === rule && (!pathPart || (i.url || '').includes(pathPart)));
  const expect = [
    ['h1-multiple', '/about'], ['meta-missing', '/about'], ['h1-empty', '/orphan-page'], ['orphan-pages', '/orphan-page'], ['broken-internal-links', '/broken-page'],
    ['schema-valid', '/services/wordpress'], ['img-alt-missing', '/services/web-design'], ['img-oversized'], ['meta-length', '/services/web-design'],
    ['cannibalisation'], ['redirect-chains', '/old-page'], ['sitemap-quality', '/missing-from-site'], ['utility-noindex', '/thank-you'],
    ['custom-404'], ['heading-hierarchy', '/about'], ['schema-article', '/blog/best-web-design-services'], ['staging-detected'], ['https'],
  ];
  let fail = 0;
  for (const [rule, p] of expect) { const ok = has(rule, p); if (!ok) fail++; console.log(`${ok ? '✓' : '✗'} ${rule}${p ? ' on ' + p : ''}`); }
  console.log(`\nScore ${a.score}/100 · ${a.readiness} · ${issues.length} issues · ${a.pages_scanned} pages`);
  if (a.readiness !== 'NOT_READY') { console.log('✗ expected NOT_READY'); fail++; }
  const chat = await j(`/api/audits/${auditId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Which pages are orphaned?' }) });
  const chatOk = /orphan-page/.test(chat.answer || ''); console.log(`${chatOk ? '✓' : '✗'} assistant answers from audit data`); if (!chatOk) fail++;
  stop(fail ? 1 : 0);
})().catch(e => { console.error(e); stop(1); });
