// AI SEO Assistant — shared chat component used by the floating drawer and the full page.
import { api } from '../api.js';
import { esc, md, srcBadge, copyText, host } from '../ui.js';

export const PROMPTS = [
  'What are the 5 most important issues before launch?', 'Is this website ready for client delivery?', 'Which pages have missing meta descriptions?',
  'Show me all duplicate titles', 'Which pages are orphaned?', 'Which pages have potential keyword cannibalisation?', 'Suggest a better title for the homepage',
  'Suggest alt text for these images', 'Create a developer fix checklist', 'Create a PM checklist', 'Generate a final SEO QA summary', 'Write a client summary',
];

function parseBot(content) { try { const j = JSON.parse(content); return { text: j.text, source: j.source }; } catch { return { text: content, source: 'ai' }; } }

export function mountChat(container, app, { compact = false } = {}) {
  const a = app.audit;
  container.innerHTML = `
    <div class="chat" id="chatLog"></div>
    <div class="prompts" id="chatPrompts">${PROMPTS.slice(0, compact ? 6 : PROMPTS.length).map(p => `<button type="button">${esc(p)}</button>`).join('')}</div>
    <form class="chat-in" id="chatForm"><textarea class="input" id="chatIn" placeholder="Ask about this audit… e.g. “Why did the homepage fail?”" aria-label="Message"></textarea><button class="btn primary" type="submit">Send</button></form>`;
  const log = container.querySelector('#chatLog');
  const input = container.querySelector('#chatIn');
  const bubble = (role, text, source) => {
    const div = document.createElement('div');
    div.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
    div.innerHTML = role === 'user' ? esc(text) : `<div class="src row between">${srcBadge(source)}<button class="btn ghost sm" data-copy title="Copy" style="padding:2px 8px">Copy</button></div>${md(text)}`;
    if (role !== 'user') div.querySelector('[data-copy]').onclick = () => copyText(text);
    log.appendChild(div); log.scrollTop = log.scrollHeight;
    return div;
  };
  const intro = () => bubble('assistant', `Hi — I'm the Mavlers SEO Assistant for **${host(a.url)}** (audit #${a.id}, score **${Math.round(a.score)}/100**). I answer from this audit's crawl data, issues and the Mavlers standards.${app.health?.ai ? '' : '\n\n_Running the built-in assistant: audit questions and template suggestions. Set `ANTHROPIC_API_KEY` on the server for free-form AI answers._'}`, 'audit');

  const send = async (text) => {
    text = text.trim(); if (!text) return;
    bubble('user', text); input.value = '';
    const wait = bubble('assistant', '…', 'audit'); wait.innerHTML = '<span class="spinner"></span>';
    try { const r = await api.post(`/api/audits/${a.id}/chat`, { message: text }); wait.remove(); bubble('assistant', r.answer, r.source); }
    catch (e) { wait.innerHTML = `<span style="color:var(--crit)">${esc(e.message)}</span>`; }
  };
  container.querySelector('#chatForm').addEventListener('submit', e => { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });
  container.querySelector('#chatPrompts').addEventListener('click', e => { const b = e.target.closest('button'); if (b) send(b.textContent); });

  api.get(`/api/audits/${a.id}/chat`).then(hist => {
    intro();
    hist.forEach(m => { if (m.role === 'user') bubble('user', m.content); else { const p = parseBot(m.content); bubble('assistant', p.text, p.source); } });
  });
  return { send, clear: async () => { await api.del(`/api/audits/${a.id}/chat`); log.innerHTML = ''; intro(); } };
}

export function mountDrawer(app) {
  const drawer = document.getElementById('drawer'), scrim = document.getElementById('scrim'), fab = document.getElementById('fab');
  let mountedFor = null;
  const open = () => {
    if (!app.audit || app.audit.status !== 'complete') return;
    if (mountedFor !== app.audit.id) {
      drawer.innerHTML = `<div class="drawer-h"><span class="spark">✦</span><div style="flex:1;min-width:0"><b>SEO Assistant</b><div class="tiny" style="color:#bbb">Audit #${app.audit.id} · ${esc(host(app.audit.url))}</div></div><a class="btn sm" style="background:transparent;color:#fff;border-color:#555" href="#/assistant">Full screen</a><button class="btn sm" id="dClose" style="background:var(--m-yellow);border-color:var(--m-yellow)">✕</button></div><div id="dBody" style="display:flex;flex-direction:column;flex:1;min-height:0"></div>`;
      mountChat(drawer.querySelector('#dBody'), app, { compact: true });
      drawer.querySelector('#dClose').onclick = close;
      mountedFor = app.audit.id;
    }
    drawer.classList.add('open'); scrim.classList.add('open');
    setTimeout(() => drawer.querySelector('#chatIn')?.focus(), 200);
  };
  const close = () => { drawer.classList.remove('open'); scrim.classList.remove('open'); };
  fab.onclick = open; scrim.onclick = close;
  window.addEventListener('hashchange', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}
