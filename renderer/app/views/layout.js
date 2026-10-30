// The main window's frame: the request/response split, the right-hand side panel (Spec / Git / Notes / Tools)
// and the status bar. Sizes and choices live in DB.settings.layout (store.js LAYOUT_DEFAULTS).
import { $, esc } from '../../shared/html.js';
import { unseenCount, unseenErrors } from '../../shared/notify.js';
import { emit } from '../../shared/bus.js';
import { DB, S, activeTab, currentProject, activeEnv } from '../store.js';
import { specTabHtml, specTabBadge } from './specs.js';
import { gitTabHtml } from './git.js';
import { notesHtml, renderNotesList } from './notes.js';
import { notesPopOutHtml } from '../actions/notes.js';
import { icon } from '../../shared/icons.js';

const L = () => DB.settings.layout;

export const SIDE_TABS = [['spec', 'Spec'], ['git', 'Git'], ['notes', 'Notes'], ['tools', 'Tools']];

// ---- request / response split
export function renderSplit() {
  const ws = $('workspace');
  const show = S.page === 'request' && !!S.req && !!activeTab();
  ws.style.display = show ? '' : 'none';
  if (!show) return;
  const { split, ratio } = L();
  ws.classList.toggle('split-row', split === 'row');
  ws.classList.toggle('split-column', split === 'column');
  const pct = `${Math.round(Math.min(0.85, Math.max(0.15, ratio)) * 1000) / 10}%`;
  const req = $('request-panel');
  req.style.width = split === 'row' ? pct : '';
  req.style.height = split === 'column' ? pct : '';
}

// ---- side panel
let toolsFrame = null; // created once and kept, so tool state survives switching tabs

function toolsHtml() {
  if (!toolsFrame) {
    toolsFrame = document.createElement('iframe');
    toolsFrame.src = 'tools.html?embedded=1';
    toolsFrame.title = 'Tools';
    toolsFrame.addEventListener('load', () => { toolsFrame.dataset.ready = '1'; });
    $('side-tools').append(toolsFrame);
  }
}
export const toolsFrameWindow = () => toolsFrame?.contentWindow || null;
export const toolsFrameReady = () => new Promise((resolve) => {
  if (!toolsFrame) toolsHtml();
  if (toolsFrame.dataset.ready) return resolve(toolsFrame.contentWindow);
  toolsFrame.addEventListener('load', () => resolve(toolsFrame.contentWindow), { once: true });
});

export function renderSidePanel() {
  const { sideOpen, sideTab, sideWidth } = L();
  const panel = $('side-panel');
  panel.style.display = sideOpen ? '' : 'none';
  $('side-resize').style.display = sideOpen ? '' : 'none';
  if (!sideOpen) return;
  panel.style.width = sideWidth + 'px';
  const r = S.req;
  $('side-head').innerHTML = SIDE_TABS.map(([id, label]) => {
    const badge = id === 'spec' && r ? specTabBadge(r) : '';
    return `<button class="tab${sideTab === id ? ' active' : ''}" data-action="side-tab" data-tab="${id}">${label}${badge ? ' ' + badge : ''}</button>`;
  }).join('') + `<span class="side-head-actions">
      ${sideTab === 'tools' ? '<button class="btn-ghost small" data-action="tools-pop-out" title="Move Tools into its own window">⧉ Pop out</button>' : ''}
      ${sideTab === 'notes' && !S.notes.popped ? '<button class="btn-ghost small" data-action="notes-pop-out" title="Move Notes into their own window">⧉ Pop out</button>' : ''}
      <button class="btn-ghost small" data-action="side-close" title="Close panel">${icon('close')}</button></span>`;
  for (const [id] of SIDE_TABS) $('side-' + id).style.display = id === sideTab ? '' : 'none';
  const none = '<p class="hint">Open a request to see its spec and history here.</p>';
  if (sideTab === 'spec') $('side-spec').innerHTML = r ? specTabHtml(r) : none;
  if (sideTab === 'git') $('side-git').innerHTML = gitTabHtml(r);
  if (sideTab === 'notes') { if (S.notes.popped) $('side-notes').innerHTML = notesPopOutHtml(); else { $('side-notes').innerHTML = notesHtml(); renderNotesList(); } }
  if (sideTab === 'tools') toolsHtml();
}

// Spec content re-rendered shortly after typing in the editor, so its live check stays current.
let specTimer = null;
export function refreshSideSpecSoon() {
  clearTimeout(specTimer);
  specTimer = setTimeout(() => { if (L().sideOpen && L().sideTab === 'spec') renderSidePanel(); }, 300);
}

// ---- status bar
const statusItems = []; // other modules add items: () => html | ''
export const registerStatusItem = (fn) => statusItems.push(fn);

const branches = new Map(); // code folder → { branch, at }
export const forgetBranch = (folder) => branches.delete(folder);
function gitBranch(folder) {
  if (!folder) return '';
  const hit = branches.get(folder);
  if (!hit || Date.now() - hit.at > 30000) {
    branches.set(folder, { branch: hit?.branch || '', at: Date.now() });
    window.electronAPI.gitInfo(folder).then((r) => { branches.set(folder, { branch: r.ok ? r.branch : '', at: Date.now() }); renderStatusBar(); });
  }
  return branches.get(folder).branch;
}

export function renderStatusBar() {
  const p = currentProject(), env = activeEnv(p), t = activeTab();
  // Keep the Session toolbar's login picker and Creds in step with the active environment.
  emit('session-context', { envName: env?.name || '', loginUrls: (env?.loginUrls || []).filter((u) => u.on && u.v).map((u) => ({ label: u.k, url: u.v })) });
  const res = t?.response;
  const branch = gitBranch(p?.codeFolder);
  const last = !res ? '' : res.error ? `<span class="status-err">✗ ${esc(res.error.slice(0, 60))}</span>`
    : `<span class="${res.status < 400 ? 'status-ok' : 'status-err'}">${res.status}</span> ${res.time} ms`;
  const errors = unseenErrors(), unseen = unseenCount();
  $('status-bar').innerHTML = `
    <span class="status-item">${p ? esc(p.name) : 'No project'}</span>
    ${p ? `<button class="status-item" data-action="status-env" title="Switch environment">◉ ${env ? esc(env.name) : 'no environment'}</button>` : ''}
    ${branch ? `<button class="status-item" data-action="side-open" data-tab="git" title="${esc(p.codeFolder)} — branches">⎇ ${esc(branch)}</button>` : ''}
    ${t?.sending ? '<span class="status-item">Sending…</span>' : ''}
    <span class="status-right">
      ${statusItems.map((fn) => fn()).filter(Boolean).join('')}
      ${last ? `<span class="status-item" title="Last response in this tab">${last}</span>` : ''}
      <button class="status-item status-bell${errors ? ' has-errors' : ''}" data-action="notifications" title="Recent messages">${icon('bell')}${unseen ? ` ${unseen}` : ''}</button>
      <button class="status-item" data-action="shortcuts" title="Keyboard shortcuts">?</button>
    </span>`;
}
