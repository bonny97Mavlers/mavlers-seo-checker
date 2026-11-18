import { api } from '../api.js';
import { esc, short, sevBadge, statusBadge, srcBadge, toast, md, copyText, fmtDate, icons } from '../ui.js';

export default async function render(el, [id], app) {
  const i = await api.get(`/api/issues/${id}`);
  const s = i.standard || {};
  const d = i.detail || {};
  const listOf = (arr, fmt = (x) => esc(typeof x === 'string' ? short(x) : JSON.stringify(x))) => arr?.length ? `<ul class="small mono" style="margin:6px 0 0;padding-left:18px;max-height:220px;overflow:auto">${arr.map(x => `<li>${fmt(x)}</li>`).join('')}</ul>` : '';
  const extra = [
    d.urls && `<div class="mt-s small b">Pages sharing this value:</div>${listOf(d.urls)}`,
    d.pages && `<div class="mt-s small b">Pages involved:</div>${listOf(d.pages)}`,
    d.sources && `<div class="mt-s small b">Linked from:</div>${listOf(d.sources)}`,
    d.images && `<div class="mt-s small b">Images:</div>${listOf(d.images, x => esc(typeof x === 'string' ? x.split('/').pop() : `${x.src.split('/').pop()} — alt="${x.alt}"`))}`,
    d.resources && `<div class="mt-s small b">Insecure resources:</div>${listOf(d.resources, x => esc(x))}`,
    d.h1s && `<div class="mt-s small b">H1 elements found:</div>${listOf(d.h1s, x => esc(x || '(empty)'))}`,
    d.missing && `<div class="mt-s small b">Missing properties:</div>${listOf(d.missing, x => esc(x))}`,
    d.assets && `<div class="mt-s small b">Assets:</div>${listOf(d.assets, x => esc(typeof x === 'string' ? x : `${x.url} — ${x.cacheControl || 'no Cache-Control'}`))}`,
    d.usedOn && `<div class="mt-s small b">Used on:</div>${listOf(d.usedOn)}`,
    d.errors && `<div class="mt-s small b">Parse errors:</div>${listOf(d.errors, x => esc(`${x.error} — ${x.snippet || ''}`))}`,
  ].filter(Boolean).join('');
  const canAssign = app.can('issue:assign'); const canIgnore = app.can('issue:ignore');

  el.innerHTML = `
  <a href="javascript:history.back()" class="small b row" style="text-decoration:none;gap:4px;margin-bottom:10px"><span style="width:16px;display:inline-flex">${icons.back}</span>Back</a>
  <div class="page-head"><div><div class="row">${sevBadge(i.severity)} ${statusBadge(i.status)} ${srcBadge(i.source)}</div><h1 class="mt-s">${esc(i.title)}</h1>
    <p>Affected URL: <a class="mono" href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.url)}</a>${i.pageId ? ` · <a href="#/pages/${i.pageId}" class="b">Page analysis →</a>` : ''}</p></div></div>

  <div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)">
    <div class="stack">
      <div class="card"><div class="card-h"><h3>Current status</h3>${srcBadge(i.source)}</div><div>${esc(i.current_value || '—')}</div>${extra}
        ${i.seenBefore ? `<div class="note info mt">Also detected in audit #${i.seenBefore.id} (status there: ${esc(i.seenBefore.status)}).</div>` : ''}</div>
      <div class="card"><h3>Why this matters</h3><p style="margin-bottom:0">${esc(s.why || '')}</p></div>
      <div class="card"><div class="card-h"><h3>Mavlers standard</h3><span class="badge dark">v${s.version || 1}</span></div>
        <div class="b">${esc(s.name || i.rule_id)}</div><p class="mt-s" style="margin-bottom:6px">${esc(s.requirement || '')}</p>
        ${s.threshold && Object.keys(s.threshold).length ? `<div class="small muted">Threshold: <span class="mono">${esc(Object.entries(s.threshold).filter(([, v]) => !Array.isArray(v) || v.length < 8).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`).join(' · ') || 'see standard')}</span></div>` : ''}
        <div class="small muted mt-s">Severity: <b>${esc(s.severity)}</b> ${s.severity === 'critical' ? '— blocks client delivery' : '— should ideally be resolved'}</div></div>
      <div class="card"><h3>Recommended fix</h3><p style="margin-bottom:0">${esc(s.recommendation || '')}</p></div>
      <div class="card" style="border-color:#f0d451"><div class="card-h"><h3>✦ AI suggested fix</h3><span id="sugSrc"></span></div>
        <div id="sug" class="msg bot" style="max-width:100%;border:0;padding:0"><button class="btn sm" id="gen">Generate suggestion</button></div>
        <div class="row mt" id="sugBtns" hidden><button class="btn sm" id="copy">${icons.copy} Copy</button><button class="btn sm ghost" id="regen">Regenerate</button></div>
      </div>
    </div>

    <div class="stack">
      <div class="card"><h3 class="mb">Actions</h3>
        <div class="stack">
          <button class="btn primary" data-status="resolved" ${i.status === 'resolved' ? 'disabled' : ''}>✓ Mark as resolved</button>
          <button class="btn" data-status="in_progress" ${i.status === 'in_progress' ? 'disabled' : ''}>Mark in progress</button>
          ${canIgnore ? `<button class="btn" data-status="ignored" ${i.status === 'ignored' ? 'disabled' : ''}>Ignore</button>` : ''}
          ${['resolved', 'ignored'].includes(i.status) ? '<button class="btn ghost" data-status="open">Reopen</button>' : ''}
          <div><label class="lbl" for="assign">Assign</label><select class="select" id="assign" ${canAssign ? '' : 'disabled'}><option value="">Unassigned</option>${app.users.map(u => `<option ${u.name === i.assignee ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
        </div>
        <dl class="kv small mt" style="grid-template-columns:90px 1fr"><dt>Category</dt><dd>${esc(i.category)}</dd><dt>Created</dt><dd>${fmtDate(i.created_at)}</dd><dt>Resolved</dt><dd>${fmtDate(i.resolved_at)}</dd><dt>Rule ID</dt><dd class="mono">${esc(i.rule_id)}</dd></dl>
      </div>
      <div class="card"><h3 class="mb">Internal notes</h3>
        <div class="stack small" id="notes">${(i.notes || []).length ? i.notes.map(n => `<div style="padding:8px 10px;border-radius:8px;background:${n.system ? '#f6f6f6' : '#fffbe6'}"><b>${esc(n.by)}</b> <span class="muted tiny">${fmtDate(n.at)}</span><div>${esc(n.text)}</div></div>`).join('') : '<span class="muted">No notes yet.</span>'}</div>
        <textarea class="input mt" id="note" rows="3" placeholder="Add a note for the team…"></textarea>
        <button class="btn sm mt-s" id="addNote">Add note</button>
      </div>
    </div>
  </div>`;

  const patch = async (body, msg) => { try { await api.patch(`/api/issues/${i.id}`, body); toast(msg); await app.refreshAudit(); render(el, [id], app); } catch (e) { toast(e.message, true); } };
  el.querySelectorAll('[data-status]').forEach(b => b.onclick = () => patch({ status: b.dataset.status }, `Issue marked ${b.dataset.status.replace('_', ' ')}`));
  el.querySelector('#assign').onchange = (e) => patch({ assignee: e.target.value }, e.target.value ? `Assigned to ${e.target.value}` : 'Unassigned');
  el.querySelector('#addNote').onclick = () => { const t = el.querySelector('#note').value.trim(); if (t) patch({ note: t }, 'Note added'); };

  let raw = '';
  const gen = async () => {
    el.querySelector('#sug').innerHTML = '<span class="spinner"></span> <span class="small muted">Generating…</span>';
    try {
      const r = await api.post(`/api/issues/${i.id}/suggest`);
      raw = r.suggestion;
      el.querySelector('#sug').innerHTML = md(r.suggestion);
      el.querySelector('#sugSrc').innerHTML = srcBadge(r.source === 'standard' ? 'standard' : r.source);
      el.querySelector('#sugBtns').hidden = false;
    } catch (e) { el.querySelector('#sug').innerHTML = `<span style="color:var(--crit)">${esc(e.message)}</span>`; }
  };
  el.querySelector('#gen').onclick = gen;
  el.querySelector('#regen').onclick = gen;
  el.querySelector('#copy').onclick = () => copyText(raw.replace(/^>\s?/gm, '').replace(/```\w*\n?/g, ''));
}
