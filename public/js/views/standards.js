import { api } from '../api.js';
import { esc, toast, modal, fmtDate, srcBadge } from '../ui.js';

const PAGE_TYPES = ['home', 'page', 'blog-post', 'blog-index', 'product', 'product-category', 'contact', 'legal', 'utility'];
const SCOPE = { indexable: 'Indexable pages', html: 'All HTML pages', site: 'Site-wide' };

export default async function render(el, params, app) {
  const res = await api.get('/api/standards');
  const canEdit = app.can('standards:edit');
  const st = { q: '', cat: '' };
  const sc = res.scoring;
  const totalW = Object.values(sc.weights).reduce((x, y) => x + y, 0);

  el.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">SEO Standards Library · version ${res.version}</span><h1>Mavlers SEO standards</h1>
    <p>The source of truth for every check. Seeded from <b>“On-page SEO — included at build”</b>. Changes apply to the next audit and bump the standards version.</p></div>
    ${canEdit ? '<button class="btn" id="weights">Scoring weights</button>' : '<span class="badge grey">Read-only for your role</span>'}</div>
  <div class="card row" style="padding:14px">
    <input class="input" id="q" placeholder="Search standards…" style="max-width:320px">
    <select class="select" id="cat" style="width:auto"><option value="">All categories</option>${Object.entries(res.categories).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select>
    <span class="small muted">${res.standards.filter(s => s.enabled).length} of ${res.standards.length} enabled</span>
  </div>
  <div id="list" class="mt"></div>`;

  const draw = () => {
    const byCat = {};
    res.standards.filter(s => (!st.cat || s.category === st.cat) && (!st.q || `${s.name} ${s.requirement} ${s.id}`.toLowerCase().includes(st.q))).forEach(s => (byCat[s.category] ||= []).push(s));
    el.querySelector('#list').innerHTML = Object.entries(byCat).map(([cat, list]) => `
      <div class="card mb" style="padding:0;overflow:hidden">
        <div class="row between" style="padding:14px 18px;background:#000;color:#fff"><h3>${esc(res.categories[cat]?.label)}</h3><span class="badge yellow">Weight ${sc.weights[cat] ?? res.categories[cat]?.weight}%</span></div>
        <div class="tbl-wrap" style="border:0;border-radius:0"><table class="tbl"><thead><tr><th>Standard</th><th>Requirement</th><th>Threshold</th><th>Severity</th><th>Applies to</th><th>Type</th><th>Ver.</th><th>Enabled</th><th></th></tr></thead><tbody>
        ${list.map(s => `<tr><td style="min-width:200px"><b>${esc(s.name)}</b><div class="tiny muted mono">${esc(s.id)}</div></td>
          <td class="small" style="min-width:240px">${esc(s.requirement)}</td>
          <td class="small mono">${esc(fmtThreshold(s.threshold))}</td>
          <td>${s.severity === 'critical' ? '<span class="badge crit">Critical</span>' : '<span class="badge warn">Warning</span>'}</td>
          <td class="small">${SCOPE[s.appliesTo]}${s.pageTypes?.length ? `<div class="tiny muted">${esc(s.pageTypes.join(', '))}</div>` : ''}</td>
          <td>${srcBadge(s.source)}</td>
          <td class="small" title="Updated ${fmtDate(s.updatedAt)} by ${esc(s.updatedBy || '')}">v${s.version}</td>
          <td><label class="toggle"><input type="checkbox" data-toggle="${s.id}" ${s.enabled ? 'checked' : ''} ${canEdit ? '' : 'disabled'}><span></span></label></td>
          <td><button class="btn sm ghost" data-edit="${s.id}">${canEdit ? 'Edit' : 'View'}</button></td></tr>`).join('')}
        </tbody></table></div></div>`).join('') || '<div class="card empty">No standards match.</div>';
  };
  draw();

  el.querySelector('#q').addEventListener('input', e => { st.q = e.target.value.toLowerCase(); draw(); });
  el.querySelector('#cat').addEventListener('change', e => { st.cat = e.target.value; draw(); });
  el.querySelector('#list').addEventListener('change', async e => {
    const t = e.target.closest('[data-toggle]'); if (!t) return;
    try { const upd = await api.patch(`/api/standards/${t.dataset.toggle}`, { enabled: t.checked }); Object.assign(res.standards.find(s => s.id === upd.id), upd); toast(`${upd.name} ${upd.enabled ? 'enabled' : 'disabled'}`); }
    catch (err) { toast(err.message, true); t.checked = !t.checked; }
  });
  el.querySelector('#list').addEventListener('click', e => { const b = e.target.closest('[data-edit]'); if (b) editStandard(res.standards.find(s => s.id === b.dataset.edit), canEdit, () => render(el, params, app)); });
  el.querySelector('#weights')?.addEventListener('click', () => editWeights(res, () => render(el, params, app)));
}

const fmtThreshold = (t) => Object.entries(t || {}).filter(([k, v]) => !(Array.isArray(v) && v.length > 6)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' ') : v === '' ? '(auto)' : v}`).join(' · ') || '—';

function editStandard(s, canEdit, done) {
  const dis = canEdit ? '' : 'disabled';
  modal(`<div class="row between"><div><span class="eyebrow">${esc(s.id)} · v${s.version}</span><h2>${esc(s.name)}</h2></div><button class="btn ghost sm" data-close>✕</button></div>
  <form id="sf" class="stack mt">
    <div><label class="lbl">Standard name</label><input class="input" name="name" value="${esc(s.name)}" ${dis}></div>
    <div><label class="lbl">Requirement</label><textarea class="input" name="requirement" rows="2" ${dis}>${esc(s.requirement)}</textarea></div>
    <div class="grid g2"><div><label class="lbl">Severity</label><select class="select" name="severity" ${dis}><option value="critical" ${s.severity === 'critical' ? 'selected' : ''}>Critical — blocks delivery</option><option value="warning" ${s.severity === 'warning' ? 'selected' : ''}>Warning</option></select></div>
      <div><label class="lbl">Enabled</label><select class="select" name="enabled" ${dis}><option value="1" ${s.enabled ? 'selected' : ''}>Enabled</option><option value="0" ${!s.enabled ? 'selected' : ''}>Disabled</option></select></div></div>
    <div><label class="lbl">Threshold <span class="muted">(JSON — e.g. {"min": 50, "max": 60})</span></label><textarea class="input mono" name="threshold" rows="4" ${dis}>${esc(JSON.stringify(s.threshold || {}, null, 2))}</textarea></div>
    <div><label class="lbl">Applicable page types <span class="muted">(none ticked = all)</span></label><div class="chips">${PAGE_TYPES.map(t => `<label class="chip" style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" name="pt" value="${t}" ${s.pageTypes?.includes(t) ? 'checked' : ''} ${dis}>${t}</label>`).join('')}</div><div class="tiny muted mt-s">Scope: ${SCOPE[s.appliesTo]}</div></div>
    <div><label class="lbl">Why it matters</label><textarea class="input" name="why" rows="2" ${dis}>${esc(s.why || '')}</textarea></div>
    <div><label class="lbl">Recommendation</label><textarea class="input" name="recommendation" rows="3" ${dis}>${esc(s.recommendation)}</textarea></div>
    <div class="tiny muted">Last updated ${fmtDate(s.updatedAt)} by ${esc(s.updatedBy || 'system')}</div>
    ${canEdit ? `<div class="row between"><button type="button" class="btn ghost sm" id="reset">Reset to Mavlers default</button><div class="row"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save standard</button></div></div>` : ''}
  </form>`, {
    onMount(m, close) {
      m.querySelector('#sf').addEventListener('submit', async e => {
        e.preventDefault(); const f = e.target;
        let threshold; try { threshold = JSON.parse(f.threshold.value || '{}'); } catch { return toast('Threshold must be valid JSON', true); }
        try {
          await api.patch(`/api/standards/${s.id}`, { name: f.name.value, requirement: f.requirement.value, severity: f.severity.value, enabled: f.enabled.value === '1', threshold, why: f.why.value, recommendation: f.recommendation.value, pageTypes: [...f.querySelectorAll('[name=pt]:checked')].map(x => x.value) });
          toast('Standard saved — applies from the next audit'); close(); done();
        } catch (err) { toast(err.message, true); }
      });
      m.querySelector('#reset')?.addEventListener('click', async () => { if (!confirm('Reset this standard to the Mavlers default?')) return; await api.post(`/api/standards/${s.id}/reset`); toast('Reset to default'); close(); done(); });
    },
  });
}

function editWeights(res, done) {
  const sc = res.scoring;
  modal(`<div class="row between"><h2>Scoring weights</h2><button class="btn ghost sm" data-close>✕</button></div>
  <p class="small muted">Category weights for the overall SEO score (normalised over evaluated categories). Severity weights decide how much a critical rule counts versus a warning.</p>
  <form id="wf" class="stack">
    ${Object.entries(res.categories).map(([k, v]) => `<div class="row between"><label class="b small" for="w-${k}">${esc(v.label)}</label><input class="input" id="w-${k}" name="${k}" type="number" min="0" max="100" value="${sc.weights[k] ?? v.weight}" style="width:100px"></div>`).join('')}
    <div class="hr"></div>
    <div class="row between"><label class="b small">Critical rule weight</label><input class="input" name="sev_critical" type="number" min="0" step="0.5" value="${sc.severityWeights.critical}" style="width:100px"></div>
    <div class="row between"><label class="b small">Warning rule weight</label><input class="input" name="sev_warning" type="number" min="0" step="0.5" value="${sc.severityWeights.warning}" style="width:100px"></div>
    <div class="row between"><label class="b small">Brand name for title suffix <span class="muted">(blank = auto-detect)</span></label><input class="input" name="brandName" value="${esc(sc.brandName || '')}" style="width:200px"></div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save weights</button></div>
  </form>`, {
    onMount(m, close) {
      m.querySelector('#wf').addEventListener('submit', async e => {
        e.preventDefault(); const f = e.target;
        const weights = Object.fromEntries(Object.keys(res.categories).map(k => [k, Number(f[k].value)]));
        try { await api.patch('/api/settings/scoring', { weights, severityWeights: { critical: Number(f.sev_critical.value), warning: Number(f.sev_warning.value) }, brandName: f.brandName.value.trim() }); toast('Scoring updated — applies from the next audit'); close(); done(); }
        catch (err) { toast(err.message, true); }
      });
    },
  });
}
