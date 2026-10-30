// Window frame actions: split view, side panel (Spec / Git / Tools, incl. pop-out), Session toolbar,
// theme and zoom, top-bar menus, notifications, keyboard-shortcut sheet, settings page.
import { $, esc } from '../../shared/html.js';
import { notify, notifications, markAllSeen, clearNotifications } from '../../shared/notify.js';
import { emit } from '../../shared/bus.js';
import { DB, S, saveDB, flushDB, hasPendingSave, findReq, currentProject } from '../store.js';
import { undo as undoEdit, redo as redoEdit } from '../edits.js';
import { onMcpSettingChange } from './mcp.js';
import { renderAll, renderSplit, renderSidePanel, renderStatusBar, renderTopbar, renderPage, toolsFrameReady } from '../views/index.js';
import { openMenu } from '../views/menu.js';
import { openModal } from '../modal.js';
import { setPage } from './core.js';
import { loadGit, loadRepo } from './git.js';
import { selectActiveEnv } from './envs.js';

const L = () => DB.settings.layout;
const mac = navigator.platform.startsWith('Mac');

// ---- theme / zoom (applied on boot and when changed)
export function applyAppearance() {
  document.documentElement.dataset.theme = DB.settings.theme;
  window.electronAPI.setZoom?.(DB.settings.zoom);
  toolsFrameWindowSafe()?.postMessage({ type: 'tools:theme', theme: DB.settings.theme }, '*');
}
const toolsFrameWindowSafe = () => document.querySelector('#side-tools iframe')?.contentWindow || null;

// ---- side panel
export function openSide(tab) {
  Object.assign(L(), { sideOpen: true, sideTab: tab });
  saveDB(); renderSidePanel(); renderTopbar();
  if (tab === 'git') { loadRepo(); if (S.req) loadGit(S.req.id); }
}
function closeSide() { L().sideOpen = false; saveDB(); renderSidePanel(); renderTopbar(); }

// Send text to a tool (e.g. a token to JWT). Goes to the popped-out Tools window if it's open,
// otherwise to the Tools tab of the side panel.
export async function sendToTool(tool, value) {
  const res = await window.electronAPI.toolsSend({ tool, value });
  if (res?.target === 'window') return;
  openSide('tools');
  const win = await toolsFrameReady();
  win.postMessage({ type: 'tools:send', tool, value }, '*');
}

// ---- menus
const IMPORT_ITEMS = () => [
  { label: 'cURL command…', run: () => ACTIONS_REF['import-curl']() },
  { label: 'Collection file (this app / Postman)…', run: () => ACTIONS_REF['import-collection']() },
  { sep: true },
  { label: 'OpenAPI spec: find in code folder…', run: () => ACTIONS_REF['specs-find'](), disabled: !currentProject() },
  { label: 'OpenAPI spec: file…', run: () => ACTIONS_REF['specs-add-file'](), disabled: !currentProject() },
  { label: 'OpenAPI spec: from URL…', run: () => ACTIONS_REF['specs-add-url'](), disabled: !currentProject() },
  { sep: true },
  { label: 'api-client.json (project setup file)…', run: () => ACTIONS_REF['config-pick']() },
  { label: 'Requests from an api-client.json…', hint: 'pick which', run: () => ACTIONS_REF['config-import-requests'](), disabled: !currentProject() },
  { label: 'Token source from file…', run: () => { ACTIONS_REF['open-tokens'](); ACTIONS_REF['ts-import'](); } },
  { label: 'Captured login-window traffic → requests…', run: () => import('./io.js').then((m) => m.importCapture()) },
  { label: 'HAR file into the Network list…', hint: 'from browser DevTools', run: () => ACTIONS_REF['import-har']() },
  { sep: true },
  { label: 'Restore from backup…', hint: 'pick what', run: () => ACTIONS_REF['backup-restore']() },
];
const PROJECT_ITEMS = () => {
  const p = currentProject();
  return [
    { head: p ? p.name : 'No project' },
    { label: 'Environments…', run: () => ACTIONS_REF['open-envs']() },
    { label: `API specs…${p?.specs.length ? ` (${p.specs.length})` : ''}`, run: () => ACTIONS_REF['open-specs']() },
    { label: 'Run collection…', run: () => ACTIONS_REF['open-runner']() },
    { label: `Tasks & logs…${p?.tasks.length ? ` (${p.tasks.length})` : ''}`, run: () => ACTIONS_REF['open-tasks']() },
    { label: 'Project settings…', run: () => ACTIONS_REF['project-settings']({ id: p.id }), disabled: !p },
    { label: 'Intercepting proxy…', run: () => ACTIONS_REF['open-proxy']() },
    { label: 'Spring Boot Actuator…', hint: 'health, env, mappings, log levels', run: () => ACTIONS_REF['open-actuator'](), disabled: !p },
    { label: `Token sources…${DB.tokenSources.length ? ` (${DB.tokenSources.length})` : ''}`, run: () => ACTIONS_REF['open-tokens']() },
    { sep: true },
    { label: 'Save requests to repo', hint: p?.repo?.auto ? 'auto-sync on' : '', run: () => ACTIONS_REF['repo-save'](), disabled: !p },
    { label: 'Load requests from repo…', run: () => ACTIONS_REF['repo-load'](), disabled: !p },
    { label: 'Apply api-client.json', hint: 'from the code folder', run: () => ACTIONS_REF['config-apply'](), disabled: !p },
    { label: 'Export…', run: () => ACTIONS_REF['export-collection']() },
    { label: 'Export as api-client.json…', hint: 'setup, no secrets', run: () => ACTIONS_REF['config-export'](), disabled: !p },
    { sep: true },
    { label: 'Back up everything…', hint: 'all projects and settings', run: () => ACTIONS_REF['backup-create']() },
  ];
};

// actions/index.js passes the full action table in, so menus can run any action.
let ACTIONS_REF = {};
export const bindActions = (actions) => { ACTIONS_REF = actions; };

function showNotifications() {
  const list = notifications();
  openModal({ title: 'Recent messages', ok: 'Close', fields: [],
    html: list.length ? `<div class="notif-list">${list.map((n) => `<div class="notif ${n.kind}">${esc(n.message)}<span class="hint">${new Date(n.at).toLocaleTimeString()}</span></div>`).join('')}</div>
      <button class="mt-8 btn-ghost small" data-action="notifications-clear">Clear all</button>` : '<p class="hint">Nothing yet.</p>' });
  markAllSeen();
}

export function showShortcuts() {
  const k = (s) => s.split(' ').map((x) => `<span class="kbd">${esc(x)}</span>`).join(' ');
  const mod = mac ? '⌘' : 'Ctrl';
  const rows = [
    [`${mod} K`, 'Search requests, operations, actions, settings and pages'], [`${mod} Shift P`, 'Actions, settings and pages only (or type > after ⌘K)'],
    [`${mod} Enter`, 'Send the request'], [`${mod} Z`, 'Undo the last edit (outside text fields)'], [mac ? '⌘ Shift Z' : 'Ctrl Y', 'Redo'],
    [`${mod} W`, 'Close the request tab'], ['Ctrl Tab', 'Next tab (Shift: previous)'], ['Ctrl `', 'Toggle the terminal'],
    [`${mod} \\`, 'Toggle the side panel'], ['?', 'This list'], ['Esc', 'Close dialogs, menus and search'],
    ['Double-click divider', 'Switch side-by-side / stacked'],
  ];
  openModal({ title: 'Keyboard shortcuts', ok: 'Close', fields: [], html: `<div class="shortcuts">${rows.map(([key, what]) => `<span>${k(key)}</span><span>${esc(what)}</span>`).join('')}</div>` });
}

export function setSplit(dir) { L().split = dir; saveDB(); renderSplit(); }

export const layoutActions = {
  'side-open'(d) { openSide(d.tab); },
  'side-tab'(d) { openSide(d.tab); },
  'side-close'() { closeSide(); },
  'side-toggle-tools'() { if (L().sideOpen && L().sideTab === 'tools') closeSide(); else openSide('tools'); },
  'side-toggle-spec'() { if (L().sideOpen && L().sideTab === 'spec') closeSide(); else openSide('spec'); },
  'side-open-git'() { openSide('git'); },
  'side-toggle-notes'() {
    if (S.notes.popped) return window.electronAPI.openNotesWindow(); // already in their own window: bring it forward
    if (L().sideOpen && L().sideTab === 'notes') closeSide(); else openSide('notes');
  },
  'open-tools'() { openSide('tools'); },
  async 'tools-pop-out'() { await window.electronAPI.openToolsWindow(); closeSide(); },
  'session-toggle'() { L().session = !L().session; saveDB(); renderAll(); },
  // The Network list lives in the Session toolbar, so it's shown first.
  // Undo / redo of edits (edits.js): the items that changed in the last save go back as they were.
  'undo-edit'() { undoRedo('undo'); },
  'redo-edit'() { undoRedo('redo'); },
  'import-har'() { if (!L().session) { L().session = true; saveDB(); renderAll(); } emit('import-har'); },
  'open-settings'() { setPage('settings'); },
  'zoom-reset'() { DB.settings.zoom = 1; saveDB(); applyAppearance(); renderPage(); },
  'menu-import'(_d, el) { openMenu(IMPORT_ITEMS(), el); },
  'menu-project'(_d, el) { openMenu(PROJECT_ITEMS(), el); },
  'status-env'(_d, el) {
    const p = currentProject(); if (!p) return;
    openMenu([{ head: 'Environment' }, { label: (p.activeEnv ? '' : '✓ ') + 'No environment', run: () => selectActiveEnv('') },
      ...p.envs.map((e) => ({ label: (e.id === p.activeEnv ? '✓ ' : '') + e.name, run: () => selectActiveEnv(e.id) })),
      { sep: true }, { label: 'Edit environments…', run: () => ACTIONS_REF['open-envs']() }], el);
  },
  notifications() { showNotifications(); renderStatusBar(); },
  'notifications-clear'() { clearNotifications(); S.modal = null; renderAll(); },
  shortcuts() { showShortcuts(); },
  'welcome-new-project'() { S.sidebarMode = 'projects'; renderAll(); $('new-project-input')?.focus(); notify('Type a project name in the sidebar and press Enter'); },
  'welcome-find-specs'() {
    if (!currentProject()) { notify('Create or select a project first', 'error'); $('new-project-input')?.focus(); return; }
    ACTIONS_REF['specs-find']();
  },
};

function undoRedo(which) {
  if (hasPendingSave()) flushDB(); // the edit just made is the step to undo
  const what = (which === 'undo' ? undoEdit : redoEdit)(DB, flushDB);
  if (!what) return notify(which === 'undo' ? 'Nothing to undo' : 'Nothing to redo', 'info', 2500);
  S.tabs = S.tabs.filter((t) => findReq(t.id));
  if (S.req && !findReq(S.req.id)) S.req = S.tabs[0] ? findReq(S.tabs[0].id)?.r || null : null;
  renderAll();
  notify(`${which === 'undo' ? 'Undid' : 'Redid'} changes to ${what}`, 'info', 5000, { label: which === 'undo' ? 'Redo' : 'Undo', run: () => undoRedo(which === 'undo' ? 'redo' : 'undo') });
}

// ---- settings page inputs ('input' / 'change' events)
export function onSettingsInput(el) {
  if (el.id === 'set-ai-instructions') { DB.settings.aiPrompt.instructions = el.value; applyAiSetting(); saveDB(); return true; }
  if (el.id === 'set-zoom') { DB.settings.zoom = Number(el.value); $('set-zoom-label').textContent = Math.round(DB.settings.zoom * 100) + '%'; applyAppearance(); saveDB(); return true; }
  return false;
}
// Encrypting secrets on disk (Settings → Privacy, main/vault.js): saving rewrites db.json, accounts.json and the
// proxy's CA key the new way; then the status line is refreshed.
export async function setEncryption(on) {
  DB.settings.encryptSecrets = !!on;
  flushDB();
  await loadSecretsStatus();
  const st = S.secretsStatus;
  notify(on ? (st?.active ? `Secrets are encrypted with ${st.backend}` : 'This computer offers no secret protection: secrets stay plain text') : 'Secrets are now stored as plain text, readable by your user account only', on && !st?.active ? 'error' : 'info', 7000);
  renderAll();
}
export async function loadSecretsStatus() {
  // The main process seals on save; give the save a moment before asking.
  await new Promise((r) => setTimeout(r, 50));
  try { S.secretsStatus = await window.electronAPI.secretsStatus(); } catch { S.secretsStatus = null; }
}

// AI assistance is opt-in (Settings → Privacy): main/claude.js refuses while it's off, and the buttons are hidden.
export function applyAiSetting() {
  window.electronAPI.aiEnable?.(!!DB.settings.ai, { ...DB.settings.aiPrompt });
  const btn = document.getElementById('investigate-btn'); if (btn) btn.hidden = !DB.settings.ai;
}

export function onSettingsChange(el) {
  if (el.id === 'set-ai') { DB.settings.ai = el.checked; applyAiSetting(); saveDB(); renderAll(); return true; }
  if (el.id === 'set-encrypt') { setEncryption(el.checked); return true; }
  if (onMcpSettingChange(el)) return true;
  if (el.dataset.aiSection) { DB.settings.aiPrompt[el.dataset.aiSection] = el.checked; applyAiSetting(); saveDB(); return true; }
  if (el.name === 'set-theme') { DB.settings.theme = el.value; applyAppearance(); }
  else if (el.name === 'set-split') L().split = el.value;
  else if (el.id === 'set-side') L().sideOpen = el.checked;
  else if (el.id === 'set-session') L().session = el.checked;
  else return false;
  saveDB(); renderAll();
  return true;
}

// ---- drag handles: request/response divider, side panel edge
export function wireLayoutDrag() {
  const drag = (handle, onMove, onEnd) => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('dragging'); document.body.style.userSelect = 'none';
      const move = (ev) => onMove(ev);
      const up = () => { handle.classList.remove('dragging'); document.body.style.userSelect = ''; removeEventListener('mousemove', move); removeEventListener('mouseup', up); onEnd(); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
  };
  const ws = $('workspace');
  drag($('split-handle'), (e) => {
    const r = ws.getBoundingClientRect();
    L().ratio = L().split === 'row' ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    renderSplit();
  }, saveDB);
  $('split-handle').addEventListener('dblclick', () => setSplit(L().split === 'row' ? 'column' : 'row'));
  drag($('side-resize'), (e) => {
    L().sideWidth = Math.max(260, Math.min(innerWidth * 0.7, innerWidth - e.clientX));
    $('side-panel').style.width = L().sideWidth + 'px';
  }, saveDB);
  // The OS colour scheme can change while "system" is selected; CSS handles it, Tools follows.
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyAppearance);
}
