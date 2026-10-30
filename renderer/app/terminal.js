// Terminal panel: tabs of terminal sessions, each running commands through main/terminal.js with its
// own shell, working folder, output and running command (they run side by side). Output is appended
// to the DOM as it streams (re-rendering everything per chunk would be slow for chatty commands).
// The tabs (name, shell, folder) are remembered in DB.settings.termTabs; output isn't.
import { $, esc } from '../shared/html.js';
import { notify } from '../shared/notify.js';
import { icon } from '../shared/icons.js';
import { DB, S, saveDB, currentProject, findReq, uid } from './store.js';
import { activeVars } from './vars.js';
import { buildRequest } from './http.js';
import { toCurl } from './curl.js';
import { openModal } from './modal.js';

const MAX_OUTPUT = 400_000; // characters kept per tab
const MAX_HISTORY = 100;
const MAX_TABS = 12;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

// sessions: [{ id, name (set by the user, or '' = automatic), shell, cwd, running (process id) | null, output, histIdx, unseen }]
const T = { open: false, shells: [], home: '', platform: '', sessions: [], active: null };
export const terminalState = T;

const session = (id = T.active) => T.sessions.find((s) => s.id === id) || null;
const sessionOfProcess = (pid) => T.sessions.find((s) => s.running === pid) || null;
const baseName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p || '~';
export const tabLabel = (s) => s.name || baseName(s.cwd);

function remember() {
  DB.settings.termTabs = T.sessions.map((s) => ({ name: s.name, shell: s.shell, cwd: s.cwd }));
  DB.settings.termActive = T.sessions.findIndex((s) => s.id === T.active);
  saveDB();
}

function newSession({ name = '', shell, cwd } = {}) {
  const s = { id: uid(), name, shell: shell && T.shells.some((x) => x.id === shell) ? shell : defaultShell(), cwd: cwd || currentProject()?.codeFolder || T.home, running: null, output: '', histIdx: -1, unseen: false };
  T.sessions.push(s);
  return s;
}
const defaultShell = () => (DB.settings.termShell && T.shells.some((s) => s.id === DB.settings.termShell) ? DB.settings.termShell : T.shells[0]?.id);

let ready = null;
function init() {
  // Double-click a tab to rename it (wired once; the panel element stays, its content is re-rendered).
  if (!ready) $('terminal-panel').addEventListener('dblclick', (e) => { const tab = e.target.closest('.term-tab'); if (tab && !e.target.closest('.term-tab-close')) renameTab(tab.dataset.id); });
  ready ||= window.electronAPI.termShells().then((r) => {
    T.shells = r.shells; T.home = r.home; T.platform = r.platform;
    for (const t of DB.settings.termTabs || []) newSession(t);
    if (!T.sessions.length) newSession();
    T.active = T.sessions[Math.min(Math.max(DB.settings.termActive ?? 0, 0), T.sessions.length - 1)].id;
    window.electronAPI.onTermData(({ id, stream, data }) => { const s = sessionOfProcess(id); if (s) append(s, data, stream); });
    window.electronAPI.onTermExit(({ id, code, signal }) => {
      const s = sessionOfProcess(id); if (!s) return;
      s.running = null;
      append(s, signal ? `[stopped: ${signal}]\n` : `[exit ${code}]\n`, code ? 'stderr' : 'system');
      if (s.id === T.active) renderPrompt();
      renderTabs();
    });
  });
  return ready;
}

function append(s, text, stream = 'stdout') {
  const clean = text.replace(ANSI, '').replace(/\r\n/g, '\n');
  s.output += clean;
  if (s.output.length > MAX_OUTPUT) s.output = s.output.slice(-MAX_OUTPUT);
  if (s.id !== T.active || !T.open) { if (!s.unseen) { s.unseen = true; renderTabs(); } return; }
  const out = $('term-output'); if (!out) return;
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
  const span = document.createElement('span');
  span.className = 'term-' + stream;
  span.textContent = clean;
  out.append(span);
  while (out.childNodes.length > 2000) out.firstChild.remove();
  if (atBottom) out.scrollTop = out.scrollHeight;
}

const prompt = () => (T.platform === 'win32' ? '>' : '$');

function renderPrompt() {
  const input = $('term-input'), s = session(); if (!input || !s) return;
  $('term-run').textContent = s.running ? 'Stop' : 'Run';
  $('term-run').dataset.action = s.running ? 'term-stop' : 'term-run';
  $('term-prompt').textContent = s.running ? 'stdin' : prompt();
  input.placeholder = s.running ? 'Input for the running command (Enter sends a line)' : 'Command… (↑↓ history, Ctrl+C stops)';
  $('term-cwd').textContent = s.cwd; $('term-cwd').title = s.cwd;
  const sel = $('term-shell'); if (sel) sel.value = s.shell;
}

function tabsHtml() {
  return T.sessions.map((s, i) => `<div class="term-tab${s.id === T.active ? ' active' : ''}" role="tab" aria-selected="${s.id === T.active}" tabindex="0"
      data-action="term-tab" data-id="${esc(s.id)}" title="${esc(`${s.cwd}\n${s.shell}${s.running ? ' · running' : ''} · double-click to rename`)}">
      ${s.running ? '<span class="term-tab-dot running" title="Running"></span>' : s.unseen ? '<span class="term-tab-dot" title="New output"></span>' : ''}
      <span class="term-tab-name">${esc(tabLabel(s))}</span>${i < 9 ? `<span class="hint term-tab-key">${i + 1}</span>` : ''}
      <button class="term-tab-close" data-action="term-tab-close" data-id="${esc(s.id)}" title="Close tab${s.running ? ' (stops its command)' : ''}">${icon('close', { size: 12 })}</button></div>`).join('')
    + `<button class="btn-ghost small term-tab-new" data-action="term-tab-new" title="New terminal tab (Ctrl+Shift+T)" ${T.sessions.length >= MAX_TABS ? 'disabled' : ''}>${icon('plus')}</button>`;
}

// Just the tab strip (state dots, names) without touching the output or the command line.
function renderTabs() { const el = $('term-tabs'); if (el) el.innerHTML = tabsHtml(); }

export function renderTerminal() {
  const el = $('terminal-panel');
  el.style.display = T.open ? '' : 'none';
  if (!T.open) return;
  const s = session();
  if (s) s.unseen = false;
  el.innerHTML = `<div class="term-head">
      <div id="term-tabs" class="term-tabs" role="tablist" aria-label="Terminal tabs">${tabsHtml()}</div>
      <select id="term-shell" title="Shell for this tab">${T.shells.map((x) => `<option value="${esc(x.id)}" ${x.id === s?.shell ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
      <span id="term-cwd" class="hint term-cwd"></span>
      <span class="term-actions">
        <button class="btn-ghost small" data-action="term-cd-project" title="Change to the project's code folder">Project folder</button>
        <button class="btn-ghost small" data-action="term-insert-curl" title="Put the open request into the command line as cURL">Insert request as cURL</button>
        <button class="btn-ghost small" data-action="term-clear">Clear</button>
        <button class="btn-ghost small" data-action="term-external" title="Open the system terminal in this folder">Open external terminal</button>
        <button class="btn-ghost small" data-action="term-toggle" title="Hide (Ctrl+\`)">${icon('close')}</button></span></div>
    <pre id="term-output" class="term-output"></pre>
    <div class="term-input-row"><span id="term-prompt" class="term-prompt"></span><input type="text" id="term-input" spellcheck="false" autocomplete="off"/>
      <button class="btn-primary small" id="term-run" data-action="term-run">Run</button></div>`;
  const out = $('term-output');
  out.textContent = '';
  if (s?.output) { const span = document.createElement('span'); span.textContent = s.output; out.append(span); out.scrollTop = out.scrollHeight; }
  renderPrompt();
}

export async function toggleTerminal(force) {
  await init();
  T.open = force ?? !T.open;
  renderTerminal();
  if (T.open) $('term-input')?.focus();
}

function activate(id) {
  if (!session(id)) return;
  T.active = id; remember(); renderTerminal(); $('term-input')?.focus();
}

function addTab() {
  if (T.sessions.length >= MAX_TABS) return notify(`Up to ${MAX_TABS} terminal tabs`, 'error');
  const cur = session();
  // A new tab starts where the current one is, with the same shell.
  activate(newSession({ shell: cur?.shell, cwd: cur?.cwd }).id);
}

function closeTab(id) {
  const s = session(id); if (!s) return;
  if (s.running) window.electronAPI.termKill(s.running);
  const i = T.sessions.indexOf(s);
  T.sessions.splice(i, 1);
  if (!T.sessions.length) { newSession(); T.open = false; }
  if (T.active === id || !session()) T.active = T.sessions[Math.min(i, T.sessions.length - 1)].id;
  remember(); renderTerminal();
  if (T.open) $('term-input')?.focus();
}

function cycle(step) {
  const i = T.sessions.findIndex((s) => s.id === T.active);
  activate(T.sessions[(i + step + T.sessions.length) % T.sessions.length].id);
}

const history = () => (DB.settings.termHistory ||= []);

export async function runCommand(command, s = session()) {
  if (!command.trim() || !s) return;
  if (s.running) { window.electronAPI.termInput(s.running, command + '\n'); append(s, command + '\n', 'system'); return; }
  const h = history();
  if (h[h.length - 1] !== command) { h.push(command); if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY); saveDB(); }
  s.histIdx = -1;
  append(s, `${s.cwd} ${prompt()} ${command}\n`, 'cmd');
  const id = uid();
  s.running = id;
  renderTabs();
  const env = activeVars(currentProject()); // the active environment's variables, e.g. $baseUrl
  const res = await window.electronAPI.termRun({ id, shell: s.shell, command, cwd: s.cwd, env });
  if (!res.ok) { s.running = null; append(s, res.error + '\n', 'stderr'); }
  else {
    if (res.cwd !== s.cwd) { s.cwd = res.cwd; remember(); }
    if (res.done) s.running = null;
  }
  if (s.id === T.active) renderPrompt();
  renderTabs();
}

// Keys in the command line. → true when handled.
export function onTerminalKey(e) {
  const input = e.target, s = session(); if (!s) return false;
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') { addTab(); return true; }
  if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) { cycle(e.key === 'PageDown' ? 1 : -1); return true; }
  if (e.altKey && /^[1-9]$/.test(e.key) && T.sessions[+e.key - 1]) { activate(T.sessions[+e.key - 1].id); return true; }
  if (e.key === 'Enter') { const v = input.value; input.value = ''; runCommand(v); return true; }
  if (e.key === 'c' && e.ctrlKey && s.running && !input.selectionEnd) { window.electronAPI.termKill(s.running); return true; }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !s.running) {
    const h = history(); if (!h.length) return true;
    s.histIdx = e.key === 'ArrowUp' ? (s.histIdx < 0 ? h.length - 1 : Math.max(0, s.histIdx - 1)) : (s.histIdx < 0 ? -1 : s.histIdx + 1);
    if (s.histIdx >= h.length) s.histIdx = -1;
    input.value = s.histIdx < 0 ? '' : h[s.histIdx];
    return true;
  }
  return false;
}

function renameTab(id) {
  const s = session(id); if (!s) return;
  openModal({ title: 'Rename terminal tab', ok: 'Rename', fields: [{ key: 'name', label: 'Name (empty = the folder name)', value: s.name }],
    onOk: (v) => { s.name = v.name.trim(); remember(); renderTabs(); } });
}

export const terminalActions = {
  'term-toggle'() { toggleTerminal(); },
  'term-tab'(d) { if (d.id !== T.active) activate(d.id); },
  'term-tab-new'() { addTab(); },
  'term-tab-close'(d, _el, e) { e?.stopPropagation(); closeTab(d.id); },
  'term-run'() { const input = $('term-input'); const v = input.value; input.value = ''; runCommand(v); input.focus(); },
  'term-stop'() { const s = session(); if (s?.running) window.electronAPI.termKill(s.running); },
  'term-clear'() { const s = session(); if (s) s.output = ''; $('term-output').textContent = ''; },
  'term-cd-project'() {
    const folder = currentProject()?.codeFolder, s = session();
    if (!folder) return notify('This project has no code folder yet (project ⋯ menu, or Specs → Find in project folder)', 'error', 6000);
    s.cwd = folder; remember(); renderPrompt(); renderTabs();
  },
  'term-insert-curl'() {
    const loc = S.req && findReq(S.req.id); if (!loc) return notify('Open a request first', 'error');
    const input = $('term-input');
    // One line, so the shell gets it as a single command.
    input.value = toCurl(buildRequest(loc)).replace(/ \\\n\s*/g, ' ') + ' -sS -i';
    input.focus();
  },
  async 'term-external'() {
    const r = await window.electronAPI.termOpenExternal(session()?.cwd);
    if (!r.ok) notify('Could not open a terminal: ' + r.error, 'error');
  },
};

// The shell picker applies to the open tab (and becomes the default for new ones).
export function selectShell(id) {
  const s = session(); if (s) s.shell = id;
  DB.settings.termShell = id; remember(); renderTabs();
}
