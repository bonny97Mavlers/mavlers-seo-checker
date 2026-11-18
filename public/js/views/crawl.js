import { api } from '../api.js';
import { esc, short, toast } from '../ui.js';

export default async function (el, [id], app) {
  const auditId = Number(id);
  const audit = await api.get(`/api/audits/${auditId}`);
  el.innerHTML = `
  <div class="page-head"><div><span class="eyebrow">Audit #${auditId}</span><h1>Crawling website…</h1><p class="mono small">${esc(audit.url)}</p></div>
    <button class="btn danger sm" id="cancel">Cancel audit</button></div>
  <div class="card">
    <div class="row between"><div class="row"><span class="spinner" id="spin"></span><b id="phase">Starting</b></div><span class="small muted" id="eta"></span></div>
    <div class="bar lg mt"><i id="bar" style="width:2%"></i></div>
    <div class="grid g4 mt">
      <div class="kpi"><span class="l">Pages discovered</span><span class="n" id="k-disc">0</span></div>
      <div class="kpi"><span class="l">Pages analysed</span><span class="n" id="k-done">0</span></div>
      <div class="kpi"><span class="l">In queue</span><span class="n" id="k-q">0</span></div>
      <div class="kpi crit"><span class="l">Errors</span><span class="n" id="k-err">0</span></div>
    </div>
    <div class="mt small"><span class="muted">Current URL:</span> <span class="mono" id="cur">—</span></div>
  </div>
  <div class="grid g2 mt">
    <div class="card"><div class="card-h"><h3>Live crawl log</h3></div><div class="crawl-log" id="log"></div></div>
    <div class="card"><div class="card-h"><h3>Crawl errors</h3></div><div id="errs" class="small" style="max-height:320px;overflow:auto"><span class="muted">No errors so far.</span></div></div>
  </div>`;

  el.querySelector('#cancel').onclick = async () => { if (confirm('Cancel this audit?')) { await api.post(`/api/audits/${auditId}/cancel`); toast('Cancelling…'); } };
  let stopped = false;
  window.addEventListener('hashchange', () => { stopped = true; }, { once: true });

  const tick = async () => {
    if (stopped) return;
    let p;
    try { p = await api.get(`/api/audits/${auditId}/progress`); } catch { setTimeout(tick, 1500); return; }
    const $ = (s) => el.querySelector(s);
    if (!$('#phase')) return;
    $('#phase').textContent = p.phase || p.status;
    $('#k-disc').textContent = p.discovered || 0; $('#k-done').textContent = p.analysed || 0; $('#k-q').textContent = p.queued || 0; $('#k-err').textContent = (p.errors || []).length;
    $('#cur').textContent = p.current ? short(p.current) : '—';
    const pct = p.status === 'complete' ? 100 : p.maxPages ? Math.min(96, Math.max(3, Math.round(((p.analysed || 0) / Math.min(p.maxPages, Math.max(p.discovered || 1, 1))) * 85))) : 3;
    $('#bar').style.width = pct + '%';
    $('#eta').textContent = p.eta != null && p.status === 'crawling' ? `≈ ${p.eta < 60 ? p.eta + 's' : Math.round(p.eta / 60) + ' min'} remaining` : '';
    const rec = (p.recent || []).slice().reverse();
    $('#log').innerHTML = rec.map(r => `<div class="${r.status >= 200 && r.status < 300 ? 'ok' : r.status >= 300 && r.status < 400 ? 'w' : 'e'}">${r.status >= 200 && r.status < 400 ? '✓' : '✕'} ${r.status || 'ERR'} ${esc(short(r.url))}${r.label && r.label !== 'page' ? ` <span style="opacity:.6">(${esc(r.label)})</span>` : ''}</div>`).join('') + (p.current && p.status !== 'complete' ? `<div class="cur pulse">→ ${esc(short(p.current))}</div>` : '');
    $('#log').scrollTop = 1e9;
    if ((p.errors || []).length) $('#errs').innerHTML = p.errors.slice(-80).reverse().map(e => `<div style="padding:4px 0;border-bottom:1px solid #f2f2f2" class="mono">${esc(e)}</div>`).join('');
    if (p.status === 'complete') {
      $('#spin').remove(); $('#phase').textContent = 'Audit complete — opening dashboard…';
      await app.setAudit(auditId);
      setTimeout(() => app.go(''), 700);
      return;
    }
    if (p.status === 'failed') {
      $('#spin').remove(); $('#phase').innerHTML = `<span style="color:var(--crit)">Audit failed: ${esc((p.errors || []).slice(-1)[0] || '')}</span>`;
      $('#cancel').outerHTML = '<a class="btn primary sm" href="#/audits/new">Try again</a>';
      return;
    }
    setTimeout(tick, 900);
  };
  tick();
}
