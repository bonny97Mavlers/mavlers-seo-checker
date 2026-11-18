// App shell: state, router, navigation, context bar and the floating AI assistant.
import { api } from './api.js';
import { esc, icons, readinessBadge, host, fmtDate, toast } from './ui.js';
import * as assistant from './views/assistant.js';

const NAV = [
  ['', 'Dashboard', 'dashboard'], ['projects', 'Projects', 'projects'], ['audits', 'SEO Audits', 'audit'], ['readiness', 'Launch Readiness', 'launch'],
  ['issues', 'Issues', 'issues'], ['pages', 'Pages', 'pages'], ['structure', 'Site Structure', 'structure'], null,
  ['standards', 'SEO Standards', 'standards'], ['assistant', 'AI SEO Assistant', 'ai'], ['history', 'Audit History', 'history'], ['reports', 'Reports', 'reports'], null,
  ['settings', 'Settings', 'settings'],
];

const ROUTES = [
  [/^$/, 'dashboard'], [/^projects$/, 'projects'], [/^audits\/new$/, 'newAudit'], [/^audits$/, 'audits'], [/^audits\/(\d+)\/crawl$/, 'crawl'], [/^audits\/(\d+)$/, 'openAudit'],
  [/^readiness$/, 'readiness'], [/^issues$/, 'issues'], [/^issues\/(\d+)$/, 'issueDetail'], [/^pages$/, 'pages'], [/^pages\/(\d+)$/, 'pageDetail'],
  [/^structure$/, 'structure'], [/^standards$/, 'standards'], [/^assistant$/, 'assistantPage'], [/^history$/, 'history'], [/^compare$/, 'compare'],
  [/^reports$/, 'reports'], [/^settings$/, 'settings'],
];

export const app = {
  health: null, users: [], me: null, audit: null, project: null,
  get auditId() { return Number(localStorage.getItem('seo.audit')) || null; },
  can(perm) { const p = app.me?.permissions || []; return p.includes('*') || p.includes(perm); },
  async setAudit(id) {
    if (id) localStorage.setItem('seo.audit', id); else localStorage.removeItem('seo.audit');
    await app.loadAudit();
  },
  async loadAudit() {
    app.audit = null; app.project = null;
    if (app.auditId) {
      try { app.audit = await api.get(`/api/audits/${app.auditId}`); app.project = await api.get(`/api/projects/${app.audit.project_id}`); }
      catch { localStorage.removeItem('seo.audit'); }
    }
    if (!app.audit) {
      // fall back to the most recent completed audit
      const list = await api.get('/api/audits').catch(() => []);
      const last = list.find(a => a.status === 'complete');
      if (last) { localStorage.setItem('seo.audit', last.id); app.audit = await api.get(`/api/audits/${last.id}`); app.project = await api.get(`/api/projects/${last.project_id}`); }
    }
    renderContext();
  },
  go(hash) { location.hash = hash.startsWith('#') ? hash : '#/' + hash.replace(/^\//, ''); },
  query() { return new URLSearchParams(location.hash.split('?')[1] || ''); },
  /** Re-fetch the current audit summary (after status changes) without re-rendering the view. */
  async refreshAudit() { if (app.auditId) { app.audit = await api.get(`/api/audits/${app.auditId}`); renderContext(); } },
};
window.__app = app;

function renderNav(active) {
  document.getElementById('nav').innerHTML = NAV.map(n => n ? `<a href="#/${n[0]}" class="${active === n[0] ? 'active' : ''}" title="${n[1]}">${icons[n[2]]}<span>${n[1]}</span></a>` : '<div class="sep"></div>').join('');
}

function renderContext() {
  const el = document.getElementById('ctx');
  const a = app.audit;
  if (!a) { el.innerHTML = '<span class="muted small">No audit selected — run your first audit to get started.</span>'; document.getElementById('fab').hidden = true; return; }
  const audits = (app.project?.audits || []).filter(x => x.status === 'complete');
  el.innerHTML = `<span class="eyebrow">${esc(app.project?.name || '')}</span>
    <span class="site" title="${esc(a.url)}">${esc(host(a.url))}</span>
    <select class="select" id="auditPick" style="width:auto;padding:5px 10px;font-size:12px" aria-label="Select audit">
      ${audits.map(x => `<option value="${x.id}" ${x.id === a.id ? 'selected' : ''}>Audit #${x.id} · ${fmtDate(x.finished_at)} · ${x.score ?? '–'}/100</option>`).join('')}
      ${a.status !== 'complete' ? `<option selected>Audit #${a.id} · ${a.status}</option>` : ''}
    </select>
    ${a.status === 'complete' ? `${readinessBadge(a.readiness)} <span class="small b">${Math.round(a.score)}/100</span>` : `<span class="badge info">${esc(a.status)}</span>`}`;
  el.querySelector('#auditPick')?.addEventListener('change', async (e) => { await app.setAudit(Number(e.target.value)); route(); });
  document.getElementById('fab').hidden = a.status !== 'complete';
}

function renderFoot() {
  const h = app.health || {};
  document.getElementById('sideFoot').innerHTML = `<div>Standards v${h.standardsVersion ?? '–'}</div>
    <div class="pill"><span class="dot ${h.ai ? 'on' : 'off'}"></span>AI: ${h.ai ? 'Claude connected' : 'built-in assistant'}</div>
    <div class="pill"><span class="dot ${h.pagespeed ? 'on' : 'off'}"></span>PageSpeed: ${h.pagespeed ? 'connected' : 'not connected'}</div>`;
}

const loaded = {};
async function loadView(name) {
  if (!loaded[name]) loaded[name] = await import(`./views/${name}.js`);
  return loaded[name];
}

let routeToken = 0;
export async function route() {
  const token = ++routeToken;
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0].split('#')[0];
  let match = null, params = [];
  for (const [re, name] of ROUTES) { const m = hash.match(re); if (m) { match = name; params = m.slice(1); break; } }
  const view = document.getElementById('view');
  const navKey = hash.split('/')[0] === 'audits' ? 'audits' : hash.split('/')[0] === 'compare' ? 'history' : hash.split('/')[0];
  renderNav(hash === '' ? '' : navKey);
  document.getElementById('side').classList.remove('open');
  if (!match) { view.innerHTML = '<div class="empty"><h3>Page not found</h3><a class="btn" href="#/">Back to dashboard</a></div>'; return; }
  if (match === 'openAudit') { await app.setAudit(Number(params[0])); if (token === routeToken) app.go(''); return; }
  view.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    const mod = await loadView(match);
    if (token !== routeToken) return;
    if (mod.needsAudit && !app.audit) { view.innerHTML = noAudit(); return; }
    if (mod.needsAudit && app.audit.status !== 'complete') { view.innerHTML = auditNotReady(); return; }
    await mod.default(view, params, app);
    view.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (e) {
    console.error(e);
    if (token === routeToken) view.innerHTML = `<div class="card note crit"><b>Something went wrong.</b> ${esc(e.message)}</div>`;
  }
}

const noAudit = () => `<div class="hero"><span class="eyebrow" style="color:var(--m-yellow)">Mavlers internal QA</span><h1 class="mt-s">SEO Pre-Launch Checker</h1><p>Check your website before client delivery.</p><a class="btn primary lg mt" href="#/audits/new">Run your first SEO audit</a></div>`;
const auditNotReady = () => app.audit.status === 'failed'
  ? `<div class="card note crit"><b>Audit #${app.audit.id} failed:</b> ${esc(app.audit.error || 'Unknown error')}<div class="mt"><a class="btn" href="#/audits/new">Run a new audit</a></div></div>`
  : `<div class="card"><div class="row"><span class="spinner"></span><b>Audit #${app.audit.id} is still running.</b></div><a class="btn mt" href="#/audits/${app.audit.id}/crawl">View live progress</a></div>`;

async function init() {
  const logo = document.getElementById('brandLogo');
  logo.onload = () => { logo.hidden = false; document.getElementById('brandWordmark').hidden = true; };
  document.getElementById('burger').onclick = () => document.getElementById('side').classList.toggle('open');
  try {
    [app.health, app.users] = await Promise.all([api.get('/api/health'), api.get('/api/users')]);
  } catch (e) { toast(e.message, true); }
  if (!api.store.user && app.users[0]) api.store.user = app.users[0].id;
  app.me = await api.get('/api/me').catch(() => null);
  const sel = document.getElementById('asUser');
  sel.innerHTML = app.users.map(u => `<option value="${u.id}" ${String(u.id) === String(api.store.user) ? 'selected' : ''}>${esc(u.name)} (${u.role.toUpperCase()})</option>`).join('');
  sel.onchange = async () => { api.store.user = sel.value; app.me = await api.get('/api/me'); toast(`Now viewing as ${app.me.user.name}`); route(); };
  renderFoot();
  if (app.health?.vercel && app.health?.db === 'sqlite') {
    const b = document.createElement('div');
    b.className = 'note crit'; b.style.cssText = 'margin:12px 28px 0;border-radius:8px';
    b.innerHTML = '<b>Temporary database.</b> No Postgres is connected, so audits are stored in short-lived storage and will disappear. Connect Neon Postgres in Vercel → Storage, then redeploy.';
    document.querySelector('.main').insertBefore(b, document.getElementById('view'));
  }
  await app.loadAudit();
  assistant.mountDrawer(app);
  window.addEventListener('hashchange', route);
  route();
}
init();
