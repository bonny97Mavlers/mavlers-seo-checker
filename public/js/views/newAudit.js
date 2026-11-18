import { api } from '../api.js';
import { esc, toast } from '../ui.js';

export default async function (el, params, app) {
  const q = app.query();
  const projects = await api.get('/api/projects').catch(() => []);
  const presetProject = projects.find(p => String(p.id) === q.get('project'));
  el.innerHTML = `
  <div class="hero">
    <span class="eyebrow" style="color:var(--m-yellow)">Mavlers internal QA</span>
    <h1 class="mt-s">SEO Pre-Launch Checker</h1>
    <p>Check your website before client delivery.</p>
  </div>
  <form class="card mt" id="f" autocomplete="off" style="padding:28px">
    <div class="grid" style="grid-template-columns:2fr 1fr;gap:16px">
      <div><label class="lbl" for="url">Website URL</label>
        <input class="input xl" id="url" name="url" placeholder="https://example.com" required value="${esc(presetProject?.url || q.get('url') || '')}"></div>
      <div><label class="lbl" for="pname">Project name <span class="muted">(optional)</span></label>
        <input class="input xl" id="pname" list="plist" placeholder="Auto from domain" value="${esc(presetProject?.name || '')}">
        <datalist id="plist">${projects.map(p => `<option value="${esc(p.name)}">`).join('')}</datalist></div>
    </div>
    <div class="mt">
      <label class="lbl">Pages to crawl</label>
      <div class="chips" id="limits">
        ${[10, 25, 50, 100].map(n => `<button type="button" class="chip ${n === 25 ? 'on' : ''}" data-n="${n}">${n}</button>`).join('')}
        <button type="button" class="chip" data-n="custom">Custom</button>
        <input class="input" id="custom" type="number" min="1" max="500" placeholder="e.g. 250" style="width:120px;display:none">
      </div>
    </div>
    <div class="mt">
      <label class="lbl">Options</label>
      <div class="grid g3">
        ${[['sitemap', 'Crawl XML sitemap', 'Queue every URL listed in the sitemap', true], ['internalLinks', 'Discover internal links', 'Follow links found on each page', true], ['externalLinks', 'Check external links', 'Verify outbound links resolve (slower)', false],
    ['images', 'Analyse images', 'Alt text, filenames, formats and file weight', true], ['structuredData', 'Analyse structured data', 'Validate JSON-LD and required fields', true], ['technical', 'Run technical checks', 'HTTPS/www variants, 404, caching, compression', true]]
    .map(([k, l, d, on]) => `<label class="check"><input type="checkbox" name="${k}" ${on ? 'checked' : ''}><span><b>${l}</b><br><span class="small muted">${d}</span></span></label>`).join('')}
      </div>
    </div>
    <div class="row mt" style="justify-content:space-between">
      <span class="small muted">The crawl runs on the server, stays on this domain, and respects the page limit.${app.health?.allowPrivate ? ' <b>Dev mode: private hosts allowed.</b>' : ''}</span>
      <button class="btn primary lg" type="submit" id="go" ${app.can('audit:run') ? '' : 'disabled title="Your role cannot run audits"'}>Run SEO audit</button>
    </div>
  </form>`;

  let limit = 25;
  const custom = el.querySelector('#custom');
  el.querySelector('#limits').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    el.querySelectorAll('#limits .chip').forEach(c => c.classList.toggle('on', c === b));
    custom.style.display = b.dataset.n === 'custom' ? 'inline-block' : 'none';
    if (b.dataset.n === 'custom') custom.focus(); else limit = Number(b.dataset.n);
  });
  el.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const maxPages = custom.style.display !== 'none' ? Number(custom.value) || 25 : limit;
    const name = el.querySelector('#pname').value.trim();
    const existing = projects.find(p => p.name.toLowerCase() === name.toLowerCase());
    const body = {
      url: f.url.value.trim(), projectName: name || undefined, projectId: existing?.id,
      options: { maxPages, sitemap: f.sitemap.checked, internalLinks: f.internalLinks.checked, externalLinks: f.externalLinks.checked, images: f.images.checked, structuredData: f.structuredData.checked, technical: f.technical.checked },
    };
    const btn = el.querySelector('#go'); btn.disabled = true; btn.textContent = 'Starting…';
    try {
      const r = await api.post('/api/audits', body);
      localStorage.setItem('seo.audit', r.auditId);
      app.go(`audits/${r.auditId}/crawl`);
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Run SEO audit'; }
  });
  el.querySelector('#url').focus();
}
