// Tasks page: run local services and follow log sources.
import { $ } from '../../shared/html.js';
import { notify } from '../../shared/notify.js';
import { S, saveDB, currentProject, uid } from '../store.js';
import { newTask, newLogSource, taskDef, taskState, logIdsFor, sourceDef, sourceParts, SEARCHABLE } from '../tasks.js';
import { renderPage, renderStatusBar } from '../views/index.js';
import { refreshLogView, searchResultsHtml } from '../views/tasks.js';
import { markSeen } from '../logwatch.js';
import { openMenu } from '../views/menu.js';
import { openModal } from '../modal.js';
import { setPage } from './core.js';

const p = () => currentProject();
const selected = () => {
  const proj = p(); if (!proj) return null;
  const id = S.tasks.id || proj.tasks[0]?.id || proj.logSources[0]?.id;
  const task = proj.tasks.find((t) => t.id === id);
  if (task) return { kind: 'task', item: task };
  const src = proj.logSources.find((s) => s.id === id);
  return src ? { kind: 'source', item: src } : null;
};
const api = window.electronAPI;

async function startTask(t) {
  const res = await api.taskStart(taskDef(p(), t));
  if (!res.ok) notify(res.error, 'error', 8000);
  renderPage(); renderStatusBar();
}

export const taskActions = {
  'open-tasks'() { setPage('tasks'); },
  'task-select'(d) { S.tasks.id = d.id; renderPage(); refreshLogView(); },
  'task-new'() {
    const proj = p(); if (!proj) return;
    const t = newTask(); proj.tasks.push(t); S.tasks.id = t.id; S.tasks.editing = true; saveDB(); renderPage();
    $('task-name')?.select();
  },
  'task-delete'() {
    const sel = selected(); if (sel?.kind !== 'task') return;
    openModal({ title: `Delete task "${sel.item.name}"?`, ok: 'Delete', fields: [], onOk: () => {
      api.taskStop(sel.item.id);
      p().tasks = p().tasks.filter((t) => t !== sel.item); S.tasks.id = null; saveDB(); renderPage();
    } });
  },
  'task-edit-toggle'() { S.tasks.editing = !S.tasks.editing; },
  async 'task-detect'(_d, el) {
    const proj = p(), sel = selected(); if (!proj || sel?.kind !== 'task') return;
    const folder = taskDef(proj, sel.item).cwd;
    if (!folder) return notify('Set the project\'s code folder (Project → Project settings) or the task\'s folder first', 'error', 7000);
    const found = await api.taskDetect(folder);
    if (!found.length) return notify(`No Maven / Gradle build or jar found in ${folder}`, 'error', 7000);
    openMenu(found.map((f) => ({ label: f.command, hint: f.name, run: () => {
      sel.item.command = f.command; if (sel.item.name === 'New task') sel.item.name = f.name;
      saveDB(); renderPage();
    } })), el);
  },
  'task-start'() { const sel = selected(); if (sel?.kind === 'task') startTask(sel.item); },
  async 'task-stop'() { const sel = selected(); if (sel?.kind === 'task') { await api.taskStop(sel.item.id); renderPage(); } },
  async 'task-restart'() {
    const sel = selected(); if (sel?.kind !== 'task') return;
    const res = await api.taskRestart(taskDef(p(), sel.item));
    if (!res.ok) notify(res.error, 'error', 8000);
    renderPage();
  },
  // ---- log sources
  'ls-new'() {
    const proj = p(); if (!proj) return;
    const s = newLogSource(); proj.logSources.push(s); S.tasks.id = s.id; saveDB(); renderPage();
  },
  'ls-delete'() {
    const sel = selected(); if (sel?.kind !== 'source') return;
    api.logsSourceStop(sel.item.id);
    p().logSources = p().logSources.filter((s) => s !== sel.item); S.tasks.id = null; saveDB(); renderPage();
  },
  async 'ls-start'() {
    const sel = selected(); if (sel?.kind !== 'source') return;
    const s = sel.item;
    const res = await api.logsSourceStart(sourceDef(p(), s));
    if (!res.ok) return notify(res.error, 'error', 8000);
    s.running = true; saveDB(); renderPage();
  },
  async 'ls-stop'() {
    const sel = selected(); if (sel?.kind !== 'source') return;
    await api.logsSourceStop(sel.item.id); sel.item.running = false; saveDB(); renderPage();
  },
  async 'ls-browse'() {
    const sel = selected(); if (sel?.kind !== 'source') return;
    const path = await api.pickFile({ title: 'Log file', filters: [{ name: 'Logs', extensions: ['log', 'txt', 'out'] }, { name: 'All files', extensions: ['*'] }] });
    if (path) { sel.item.path = path; saveDB(); renderPage(); }
  },
  'log-view'(d) { S.tasks.view = d.view; if (d.view === 'flagged') { markSeen(); renderStatusBar(); } renderPage(); if (d.view === 'live') refreshLogView(); else document.getElementById('ls-q')?.focus(); },
  async 'log-search'() {
    const q = S.tasks.search, proj = p(), sel = selected();
    if (!proj || q.running) return;
    if (!q.pattern.trim()) return notify('Enter something to search for', 'error');
    const sources = q.scope === 'source' && sel?.kind === 'source' && SEARCHABLE.has(sel.item.type) ? [sel.item] : proj.logSources.filter((x) => SEARCHABLE.has(x.type));
    if (!sources.length) return notify('No searchable log sources in this project', 'error');
    q.running = true;
    q.results = sources.map((src) => ({ name: src.name, running: true, hits: [], searchId: uid() }));
    renderPage();
    await searchSources(proj, sources, q);
  },
  'log-search-cancel'() { for (const r of S.tasks.search.results) if (r.running) api.logsSearchCancel(r.searchId); },
  async 'log-clear'() { const sel = selected(); if (sel) { await api.logsClear(sel.item.id); (await import('../tasks.js')).logLines(sel.item.id).length = 0; refreshLogView(); } },
};

// Runs a search in each source at once; each source's results appear as they arrive.
async function searchSources(proj, sources, q) {
  const query = { pattern: q.pattern, regex: q.regex, ignoreCase: q.ignoreCase, context: q.context, since: q.since, max: q.max };
  const show = () => { const el = document.getElementById('log-search-results'); if (el) el.innerHTML = searchResultsHtml(q.results, q); };
  await Promise.all(sources.map(async (src, i) => {
    const r = q.results[i];
    const res = await api.logsSearch(r.searchId, sourceDef(proj, src), query);
    Object.assign(r, res.ok ? res : { error: res.error }, { running: false });
    show();
  }));
  q.running = false;
  if (S.page === 'tasks') renderPage();
  const total = q.results.reduce((n, r) => n + (r.hits?.length || 0), 0);
  notify(`Log search: ${total} match${total === 1 ? '' : 'es'} in ${sources.length} source${sources.length === 1 ? '' : 's'}`, q.results.some((r) => r.error) ? 'error' : 'info');
}

// Field edits on the Tasks page.
export function onTaskInput(el) {
  const sel = selected();
  if (el.id === 'log-filter') { S.tasks.filter = el.value; refreshLogView(); return true; }
  if (el.id === 'ls-q') { S.tasks.search.pattern = el.value; return true; }
  if (!sel) return false;
  if (sel.kind === 'task' && el.id?.startsWith('task-')) {
    const key = el.id.slice(5);
    if (!(key in sel.item)) return false;
    sel.item[key] = el.type === 'checkbox' ? el.checked : el.value;
    saveDB(); return true;
  }
  if (sel.kind === 'source' && el.id?.startsWith('ls-')) {
    const key = el.id.slice(3);
    // Per-type settings: ls-ssh-host → item.ssh.host
    const [part, field] = key.split('-');
    if (field && ['ssh', 'k8s', 'docker'].includes(part)) {
      Object.assign(sel.item, sourceParts(sel.item));
      sel.item[part][field] = el.value; saveDB(); return true;
    }
    if (!(key in sel.item)) return false;
    sel.item[key] = el.value; saveDB(); return true;
  }
  return false;
}
export function onTaskChange(el) {
  if (el.id === 'log-level') { S.tasks.level = el.value; refreshLogView(); return true; }
  if (el.id === 'log-follow') { S.tasks.follow = el.checked; refreshLogView(); return true; }
  const q = S.tasks.search;
  const searchFields = { 'ls-q-regex': () => { q.regex = el.checked; }, 'ls-q-icase': () => { q.ignoreCase = el.checked; }, 'ls-q-context': () => { q.context = +el.value; },
    'ls-q-since': () => { q.since = el.value; }, 'ls-q-max': () => { q.max = +el.value; }, 'ls-q-scope': () => { q.scope = el.value; } };
  if (searchFields[el.id]) { searchFields[el.id](); return true; }
  const sel = selected(); if (!sel) return false;
  if (el.name === 'ls_type' && sel.kind === 'source') { Object.assign(sel.item, sourceParts(sel.item), { type: el.value }); S.tasks.editing = true; saveDB(); renderPage(); return true; }
  if (el.id === 'task-waitForReady' && sel.kind === 'task') { sel.item.waitForReady = el.checked; saveDB(); return true; }
  if (el.id === 'task-name' || el.id === 'ls-name') { renderPage(); return true; } // refresh the list label
  return false;
}

// Before sending: tasks of the project that are still starting (and set to hold sends) are awaited.
export async function waitForTasks(proj) {
  const waiting = (proj?.tasks || []).filter((t) => t.waitForReady && taskState(t.id) === 'starting');
  if (!waiting.length) return;
  notify(`Waiting for ${waiting.map((t) => t.name).join(', ')} to be ready…`, 'info', 6000);
  const { whenReady } = await import('../tasks.js');
  const results = await Promise.all(waiting.map((t) => whenReady(t.id)));
  results.forEach((r, i) => { if (r !== 'ready') notify(`${waiting[i].name}: ${r === 'timeout' ? 'still not ready after 3 minutes' : r} — sending anyway`, 'error', 8000); });
}

export { logIdsFor };
