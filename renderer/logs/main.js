// A popped-out log window (logs.html?id=<task or log source id>): the live log with filter / level /
// follow, and Search for sources that support it. Settings and Start / Stop go through the main window,
// which owns them (actions/logwindows.js); lines and searches come from the main process directly.
import { esc } from '../shared/html.js';
import { icon } from '../shared/icons.js';
import { stateChip, logEntriesHtml, searchFormHtml, searchResultsHtml } from '../shared/logview.js';

const api = window.electronAPI;
const id = new URLSearchParams(location.search).get('id');
const MAX_LINES = 20000;
const KIND_LABEL = { task: 'Task', ssh: 'Server (SSH)', kubernetes: 'Kubernetes', docker: 'Docker', file: 'File', command: 'Command' };

let info = null, def = null, searchable = false, missing = false;
let lines = [];
const ui = { view: 'live', filter: '', level: 'all', follow: true, search: { pattern: '', regex: false, ignoreCase: true, context: 2, since: '1h', max: 200, running: false, results: [], searchId: null } };
const $ = (x) => document.getElementById(x);

function renderHead() {
  if (missing) { $('logs-head').innerHTML = '<span class="hint">This task or log source no longer exists.</span>'; return; }
  if (!info) return;
  document.title = `${info.name} — logs`;
  const on = ['starting', 'ready', 'stopping'].includes(info.state);
  const startLabel = info.kind === 'task' ? `${icon('play')} Start` : `${icon('play')} Follow`;
  $('logs-head').innerHTML = `<b>${esc(info.name)}</b><span class="hint">${esc(KIND_LABEL[info.type] || '')}${info.port ? ` :${info.port}` : ''}</span>${stateChip(info.state)}
    <button class="btn-primary small" data-action="start" ${on ? 'disabled' : ''}>${startLabel}</button>
    <button class="btn-ghost small" data-action="stop" ${on ? '' : 'disabled'}>${icon('stop')} Stop</button>
    <span class="grow"></span><button class="btn-ghost small" data-action="dock" title="Close this window and show the logs on the Tasks & logs page">Dock to main window</button>`;
}

function renderBody() {
  if (missing || !info) { $('logs-body').innerHTML = ''; return; }
  const tabs = searchable ? `<div class="tabs log-view-tabs"><button class="tab${ui.view === 'live' ? ' active' : ''}" data-action="view" data-view="live">Live</button>
    <button class="tab${ui.view === 'search' ? ' active' : ''}" data-action="view" data-view="search">${icon('search')} Search logs</button></div>` : '';
  if (ui.view === 'search' && searchable) {
    $('logs-body').innerHTML = `${tabs}${searchFormHtml(ui.search, { hasWindow: ['kubernetes', 'docker'].includes(info.type) })}<div id="log-search-results" class="logs-window-scroll">${searchResultsHtml(ui.search.results, ui.search)}</div>`;
    return;
  }
  $('logs-body').innerHTML = `${tabs}<div class="log-toolbar">
      <input type="text" id="log-filter" placeholder="Filter lines…" value="${esc(ui.filter)}" spellcheck="false"/>
      <select id="log-level">${['all', 'INFO', 'WARN', 'ERROR'].map((l) => `<option value="${l}" ${ui.level === l ? 'selected' : ''}>${l === 'all' ? 'All levels' : l + '+'}</option>`).join('')}</select>
      <label class="hint"><input type="checkbox" id="log-follow" ${ui.follow ? 'checked' : ''}/> Follow</label>
      <button class="btn-ghost small" data-action="clear">Clear</button></div>
    <div id="log-view" class="log-view logs-window-scroll"></div>`;
  refreshLog();
}

// Only the log lines (keeps the filter box focused while lines stream in).
let pending = 0;
function refreshLog() {
  const view = $('log-view'); if (!view) return;
  view.innerHTML = logEntriesHtml(lines, { filter: ui.filter, minLevel: ui.level });
  if (ui.follow) view.scrollTop = view.scrollHeight;
}
const refreshSoon = () => { if (!pending) pending = setTimeout(() => { pending = 0; refreshLog(); }, 150); };

async function search() {
  const q = ui.search;
  if (q.running || !def) return;
  if (!q.pattern.trim()) return;
  q.running = true; q.searchId = `w${Date.now()}`;
  q.results = [{ name: info.name, running: true, hits: [] }];
  renderBody();
  const res = await api.logsSearch(q.searchId, def, { pattern: q.pattern, regex: q.regex, ignoreCase: q.ignoreCase, context: q.context, since: q.since, max: q.max });
  Object.assign(q.results[0], res.ok ? res : { error: res.error }, { running: false });
  q.running = false;
  renderBody();
}

const ACTIONS = {
  start() { api.logsToMain({ type: 'start', id }); },
  stop() { api.logsToMain({ type: 'stop', id }); },
  dock() { api.logsDock(id); },
  view(d) { ui.view = d.view; renderBody(); if (d.view === 'search') $('ls-q')?.focus(); },
  async clear() { await api.logsClear(id); lines = []; refreshLog(); },
  'log-search'() { search(); },
  'log-search-cancel'() { if (ui.search.searchId) api.logsSearchCancel(ui.search.searchId); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && !el.disabled) ACTIONS[el.dataset.action]?.(el.dataset, el);
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'log-filter') { ui.filter = el.value; refreshLog(); }
  if (el.id === 'ls-q') ui.search.pattern = el.value;
});
document.addEventListener('change', (e) => {
  const el = e.target, q = ui.search;
  const set = { 'log-level': () => { ui.level = el.value; refreshLog(); }, 'log-follow': () => { ui.follow = el.checked; refreshLog(); },
    'ls-q-regex': () => { q.regex = el.checked; }, 'ls-q-icase': () => { q.ignoreCase = el.checked; }, 'ls-q-context': () => { q.context = +el.value; },
    'ls-q-since': () => { q.since = el.value; }, 'ls-q-max': () => { q.max = +el.value; } }[el.id];
  set?.();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'ls-q') { e.preventDefault(); search(); } });

api.onLogsMessage((m) => {
  if (m.type === 'error') return;
  if (m.type !== 'state') return;
  if (m.missing) { missing = true; renderHead(); renderBody(); return; }
  const first = !info;
  if (m.theme) document.documentElement.dataset.theme = m.theme;
  info = m.item; def = m.def; searchable = m.searchable;
  if (!searchable) ui.view = 'live';
  renderHead();
  if (first) renderBody();
});
api.onLogLines(({ id: from, lines: added }) => {
  if (from !== id) return;
  lines.push(...added);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  refreshSoon();
});
api.onTaskState((s) => { if (s.id === id && info) { info = { ...info, state: s.state, port: s.port || info.port }; renderHead(); } });

api.logsLines(id, 0).then((initial) => { lines = initial || []; refreshLog(); });
api.logsToMain({ type: 'hello', id });
