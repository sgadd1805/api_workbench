// Document-level event delegation for the main window. Clicks go to ACTIONS (actions/);
// edits are mapped by element id below, key/value rows by their data-list.
import { $ } from '../shared/html.js';
import { on } from '../shared/bus.js';
import { DB, S, saveDB, setRequestUrl, activeTab, moveTab } from './store.js';
import { renderResponsePanel, renderSidebar, renderRequestPanel, renderTopbar, renderTabBar, refreshTabBody, jsonStatus, renderHistoryList, refreshSideSpecSoon, renderSidePanel } from './views/index.js';
import { closeMenu } from './views/menu.js';
import { filterBranches } from './actions/git.js';
import {
  ACTIONS, sendCurrent, closeReqTab, cycleTab, onRowInput, pickSlot, selectActiveEnv, renameSelectedEnv,
  openAccounts, onAccountInput, importCapture, openCapture, saveCaptureFlow, useLoginSession, linkOperation, openSearch, onSearchInput, onSearchKey,
  onNetworkInput, onTaskInput, onTaskChange, onRunnerInput, onRunnerChange, onLoadInput, onCompareChange, onViewerInput, onSnapshotInput, onSpecToolInput, onSpecToolChange, onProxyInput, onProxyChange, onActuatorInput, onActuatorChange, onLogWatchInput, onProtocolInput, onProtocolChange, wireLayoutDrag, onSettingsInput, onSettingsChange, showShortcuts, onNoteInput, onNoteChange, onTokenSourceInput, onTokenSourceChange,
} from './actions/index.js';
import { closeModal } from './modal.js';
import { toggleTerminal, onTerminalKey, selectShell } from './terminal.js';
import { wireEditors } from './editor.js';
import { wireSidebar } from './actions/sidebar.js';
import { wireA11y } from './a11y.js';
import { runAssertions } from './assertions.js';

// 'input' events on the request editor, keyed by element id. Each one saves the DB afterwards.
const ON_INPUT = {
  'url-input': (r, el) => { setRequestUrl(r, el.value); renderSidebar(); renderTabBar(); if (activeTab()?.editorTab === 'params') refreshTabBody(); },
  'body-text': (r, el) => { r.body.text = el.value; const st = $('json-status'); if (st) st.innerHTML = jsonStatus(el.value); },
  'assert-text': (r, el) => { r.assertions = el.value.split('\n'); recheckAssertionsSoon(); },
  'auth-token': (r, el) => { r.auth.token = el.value; },
  'auth-user': (r, el) => { r.auth.user = el.value; },
  'auth-pass': (r, el) => { r.auth.pass = el.value; },
  'opt-timeout': (r, el) => { r.options.timeoutSec = Math.max(0, Number(el.value) || 0); },
  'script-pre': (r, el) => { r.scripts.pre = el.value; },
  'script-post': (r, el) => { r.scripts.post = el.value; },
};

// Editing assertions re-checks them (in the sandbox) against the open response.
let assertTimer = 0;
function recheckAssertionsSoon() {
  clearTimeout(assertTimer);
  assertTimer = setTimeout(async () => {
    const res = activeTab()?.response, r = S.req;
    if (!res || res.error || !r) return;
    res.assertionResults = await runAssertions(r.assertions, res.status, res.body);
    if (activeTab()?.response === res) renderResponsePanel();
  }, 400);
}

// 'change' events on the request editor, keyed by element id (or radio name). Each one saves the DB afterwards.
const ON_CHANGE = {
  'method-select': (r, el) => { r.method = el.value; renderSidebar(); renderTabBar(); },
  'auth-type': (r, el) => { r.auth = { type: el.value, ...(el.value === 'token' && { sourceId: DB.tokenSources[0]?.id || '' }) }; renderRequestPanel(); },
  'auth-source': (r, el) => { r.auth.sourceId = el.value; renderRequestPanel(); },
  body_type: (r, el) => { r.body.type = el.value; renderRequestPanel(); },
  'opt-redirects': (r, el) => { r.options.followRedirects = el.checked; },
};

function onClick(e) {
  // A click outside an open menu closes it (and does nothing else).
  if (S.menu && !e.target.closest('.menu')) { closeMenu(); if (!e.target.closest('[data-action^="menu-"],[data-action="status-env"]')) return; }
  const el = e.target.closest('[data-action]');
  if (el && !el.disabled) ACTIONS[el.dataset.action]?.(el.dataset, el, e);
}

function onInput(e) {
  const el = e.target;
  if (el.dataset.accField) return onAccountInput(el);
  if (el.id === 'env-name') { renameSelectedEnv(el.value); renderTopbar(); return; }
  if (el.id === 'history-search') { S.history.filter = el.value; renderHistoryList(); return; }
  if (el.id === 'git-branch-filter') return filterBranches(el.value);
  if (el.id === 'api-search-input') return onSearchInput(el.value);
  if (el.classList?.contains('view-filter') || el.classList?.contains('view-search')) return onViewerInput(el);
  if (onSnapshotInput(el)) return;
  if (S.page === 'envs' && el.id?.startsWith('net-') && el.type !== 'checkbox' && onNetworkInput(el)) return;
  if (S.page === 'tasks' && onLogWatchInput(el)) return;
  if (S.page === 'tasks' && el.type !== 'checkbox' && onTaskInput(el)) return;
  if (S.page === 'runner' && onRunnerInput(el)) return;
  if (S.page === 'specs' && onSpecToolInput(el)) return;
  if (S.page === 'proxy' && onProxyInput(el)) return;
  if (S.page === 'actuator' && onActuatorInput(el)) return;
  if (S.page === 'load' && onLoadInput(el)) return;
  if (onSettingsInput(el) || onNoteInput(el) || (S.page === 'tokens' && onTokenSourceInput(el))) return;
  if (onProtocolInput(el)) return;
  if (onRowInput(el)) { refreshSideSpecSoon(); return; }
  const r = S.req;
  if (r && ON_INPUT[el.id]) { ON_INPUT[el.id](r, el); saveDB(); refreshSideSpecSoon(); }
}

function onChange(e) {
  const el = e.target;
  if (el.id?.startsWith('slot-sel')) return pickSlot(+el.dataset.slot, el.value);
  if (S.page === 'compare' && onCompareChange(el)) return;
  if (el.id === 'env-select') return selectActiveEnv(el.value);
  if (el.id === 'spec-op-select') return linkOperation(el.value);
  if (el.id === 'term-shell') return selectShell(el.value);
  if (S.page === 'envs' && el.id?.startsWith('net-') && el.type === 'checkbox' && onNetworkInput(el)) return;
  if (S.page === 'tasks' && onLogWatchInput(el)) return;
  if (S.page === 'tasks' && onTaskChange(el)) return;
  if (S.page === 'runner' && onRunnerChange(el)) return;
  if (S.page === 'specs' && onSpecToolChange(el)) return;
  if (S.page === 'proxy' && onProxyChange(el)) return;
  if (S.page === 'actuator') { onActuatorChange(el); return; }
  if (onSettingsChange(el) || onNoteChange(el) || (S.page === 'tokens' && onTokenSourceChange(el))) return;
  if (onProtocolChange(el)) return;
  const handler = ON_CHANGE[el.id] || ON_CHANGE[el.name];
  if (handler && S.req) { handler(S.req, el); saveDB(); refreshSideSpecSoon(); }
}

const typing = (el) => el.matches?.('input, textarea, select, [contenteditable]');

function onKeydown(e) {
  if (e.key === 'Escape' && S.menu) { closeMenu(); return; }
  if (e.target.id === 'api-search-input' && onSearchKey(e)) { e.preventDefault(); return; }
  if (e.target.id === 'term-input' && onTerminalKey(e)) { e.preventDefault(); return; }
  if (e.key === 'Enter' && e.target.classList?.contains('view-search')) { e.preventDefault(); return ACTIONS['view-step']({ dir: e.shiftKey ? -1 : 1 }); }
  if (e.ctrlKey && e.key === '`') { e.preventDefault(); return toggleTerminal(); }
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); return ACTIONS[DB.settings.layout.sideOpen ? 'side-close' : 'side-open']({ tab: DB.settings.layout.sideTab }); }
  if (e.key === '?' && !typing(e.target) && !S.modal) { e.preventDefault(); return showShortcuts(); }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); return openSearch(); }
  // ⌘⇧P / Ctrl+Shift+P: the palette with only actions, settings and pages.
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); return openSearch('>'); }
  // ⌘Z / Ctrl+Z undoes the last edit, ⌘⇧Z / Ctrl+Shift+Z / Ctrl+Y redoes it; inside a text field they're the field's own.
  if ((e.metaKey || e.ctrlKey) && !typing(e.target) && !S.modal && !S.search.open) {
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); return ACTIONS[e.shiftKey ? 'redo-edit' : 'undo-edit'](); }
    if (k === 'y' && e.ctrlKey) { e.preventDefault(); return ACTIONS['redo-edit'](); }
  }
  if (e.key === 'Enter' && e.target.id === 'new-project-input') ACTIONS['new-project']();
  if (e.key === 'Enter' && e.target.id === 'new-feature-input') ACTIONS['new-feature']();
  if (e.key === 'Enter' && e.target.id === 'ls-q') { e.preventDefault(); return ACTIONS['log-search'](); }
  if (e.key === 'Enter' && e.target.id === 'act-base') { e.preventDefault(); return ACTIONS['act-load'](); }
  if (e.key === 'Enter' && e.target.id === 'act-new-logger') { e.preventDefault(); return ACTIONS['act-set-new'](); }
  // Ctrl+Tab / Ctrl+Shift+Tab, and ⌘⇧] / ⌘⇧[ on macOS, cycle request tabs.
  if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
  if (e.metaKey && e.shiftKey && (e.key === ']' || e.key === '}')) { e.preventDefault(); cycleTab(1); }
  if (e.metaKey && e.shiftKey && (e.key === '[' || e.key === '{')) { e.preventDefault(); cycleTab(-1); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && S.req && S.page === 'request' && !S.modal) sendCurrent();
  if (e.key === 'Escape' && S.modal) closeModal();
}

// ⌘W / Ctrl+W (forwarded by main/windows.js instead of closing the window): close the active tab,
// or the window when no tabs are open.
function onCloseShortcut() {
  if (S.modal) return closeModal();
  if (S.page === 'request' && S.req) closeReqTab(S.req.id); else window.close();
}

// Middle-click closes a tab; dragging reorders them.
function wireTabBar() {
  const bar = $('tab-bar');
  bar.addEventListener('auxclick', (e) => {
    const tab = e.target.closest('.req-tab');
    if (tab && e.button === 1) { e.preventDefault(); closeReqTab(tab.dataset.id); }
  });
  let dragId = null;
  bar.addEventListener('dragstart', (e) => { dragId = e.target.closest('.req-tab')?.dataset.id; e.dataTransfer.effectAllowed = 'move'; });
  bar.addEventListener('dragover', (e) => { if (dragId) e.preventDefault(); });
  bar.addEventListener('drop', (e) => {
    e.preventDefault();
    const over = e.target.closest('.req-tab');
    const to = over ? S.tabs.findIndex((t) => t.id === over.dataset.id) : S.tabs.length - 1;
    if (dragId && to >= 0) { moveTab(dragId, to); renderTabBar(); }
    dragId = null;
  });
}

function wireSidebarResize() {
  const handle = $('sidebar-resize'), sidebar = $('sidebar'); let drag = false;
  handle.addEventListener('mousedown', () => { drag = true; handle.classList.add('dragging'); document.body.style.userSelect = 'none'; });
  window.addEventListener('mousemove', (e) => { if (drag) sidebar.style.width = Math.min(600, Math.max(160, e.clientX)) + 'px'; });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = false; handle.classList.remove('dragging'); document.body.style.userSelect = '';
    DB.settings.sidebarWidth = sidebar.offsetWidth; saveDB();
  });
}

export function wireEvents() {
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', onKeydown);
  wireEditors();
  wireSidebar(ACTIONS);
  wireA11y();
  wireSidebarResize();
  wireTabBar();
  wireLayoutDrag();
  window.electronAPI.onShortcut((name) => {
    if (name === 'close-tab') onCloseShortcut();
    if (name === 'dock-tools') ACTIONS['open-tools']();
  });
  // Requests from the dev toolbar (renderer/toolbar/toolbar.js).
  on('use-login-session', useLoginSession);
  on('import-capture', importCapture);
  on('open-capture', openCapture);
  on('capture-flow', saveCaptureFlow);
  on('open-accounts', openAccounts);
}
