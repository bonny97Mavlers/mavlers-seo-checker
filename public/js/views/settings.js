import { api } from '../api.js';
import { esc, toast } from '../ui.js';

const ROLE_INFO = {
  admin: 'Manage users, standards, projects and integrations',
  pm: 'Run audits, review and assign issues, generate reports, complete the manual checklist',
  developer: 'View technical issues and recommendations, mark issues resolved',
  seo: 'Review content and schema, manage standards, review recommendations',
};

export default async function render(el, params, app) {
  const users = await api.get('/api/users');
  const h = app.health || {};
  const isAdmin = app.can('users:manage');
  el.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">Settings</span><h1>Settings</h1></div></div>
  <div class="grid g2">
    <div class="card"><div class="card-h"><h3>Users & roles</h3>${isAdmin ? '' : '<span class="badge grey">Admin only</span>'}</div>
      <table class="tbl"><thead><tr><th>Name</th><th>Role</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr><td><b>${esc(u.name)}</b><div class="tiny muted">${esc(u.email || '')}</div></td><td><span class="badge dark">${u.role.toUpperCase()}</span></td><td>${isAdmin && u.role !== 'admin' ? `<button class="btn sm ghost" data-del="${u.id}">Remove</button>` : ''}</td></tr>`).join('')}
      </tbody></table>
      ${isAdmin ? `<form id="uf" class="row mt"><input class="input" name="name" placeholder="Name" required style="flex:1;min-width:140px"><input class="input" name="email" placeholder="Email" style="flex:1;min-width:140px"><select class="select" name="role" style="width:auto">${Object.keys(ROLE_INFO).map(r => `<option value="${r}">${r.toUpperCase()}</option>`).join('')}</select><button class="btn primary sm">Add user</button></form>` : ''}
      <div class="hr"></div>
      <dl class="kv small">${Object.entries(ROLE_INFO).map(([r, t]) => `<dt>${r.toUpperCase()}</dt><dd>${t}</dd>`).join('')}</dl>
      <p class="tiny muted">Role switching ("Viewing as") is scaffolding for the MVP. Connect Google Workspace SSO in <span class="mono">server/index.js</span> before rolling out widely.</p>
    </div>
    <div class="stack">
      <div class="card"><h3 class="mb">Integrations</h3>
        <table class="tbl"><tbody>
          <tr><td><b>Claude AI (assistant)</b><div class="tiny muted">Env: ANTHROPIC_API_KEY, optional ANTHROPIC_MODEL</div></td><td>${h.ai ? `<span class="badge ok">Connected · ${esc(h.model)}</span>` : '<span class="badge warn">Not connected — built-in assistant</span>'}</td></tr>
          <tr><td><b>Google PageSpeed Insights</b><div class="tiny muted">Env: PAGESPEED_API_KEY — enables LCP / INP / CLS checks</div></td><td>${h.pagespeed ? '<span class="badge ok">Connected</span>' : '<span class="badge grey">Not connected</span>'}</td></tr>
          ${['Google Search Console', 'Google Analytics 4', 'Google Rich Results Test', 'Lighthouse', 'Ahrefs', 'Semrush', 'Google Tag Manager'].map(n => `<tr><td><b>${n}</b></td><td><span class="badge grey">Planned</span></td></tr>`).join('')}
        </tbody></table>
        <p class="tiny muted mt-s">Integration credentials are read from server environment variables and never exposed to the browser.</p>
      </div>
      <div class="card"><h3 class="mb">Crawler</h3>
        <dl class="kv small"><dt>Mode</dt><dd>${h.allowPrivate ? '<span class="badge warn">Dev — private/local hosts allowed</span>' : 'Production — public hosts only (SSRF protection on)'}</dd>
          <dt>Limits</dt><dd>Domain-restricted, page cap per audit, per-host rate limiting, 15 s timeout, 5 MB page cap</dd>
          <dt>Tuning</dt><dd class="mono tiny">MAX_PAGES_HARD · CRAWL_CONCURRENCY · CRAWL_DELAY_MS · MAX_CONCURRENT_AUDITS · API_TOKEN</dd></dl>
      </div>
    </div>
  </div>`;
  el.querySelector('#uf')?.addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    try { await api.post('/api/users', { name: f.name.value, email: f.email.value, role: f.role.value }); toast('User added'); location.reload(); } catch (err) { toast(err.message, true); }
  });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (confirm('Remove this user?')) { await api.del(`/api/users/${b.dataset.del}`); toast('User removed'); render(el, params, app); } });
}
