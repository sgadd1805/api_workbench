// Popped-out log windows (renderer/logs/main.js), one per task or log source. The tasks and sources
// live in this window's DB, so the windows ask here for their settings and state and send Start / Stop
// / Dock here (relayed by main/windows.js); log lines and searches go to main/ directly.
// DB.settings.logWindows: ids of the windows open when the app closed, reopened on start.
import { notify } from '../../shared/notify.js';
import { DB, S, saveDB, onAfterSave } from '../store.js';
import { taskDef, taskInfo, sourceDef, SEARCHABLE, onTasksChanged } from '../tasks.js';
import { renderPage, renderStatusBar } from '../views/index.js';
import { setPage } from './core.js';

const api = () => window.electronAPI;
const open = () => (DB.settings.logWindows ||= []);

// The task or log source with this id, in any project. → { p, kind, item } | null
function find(id) {
  for (const p of DB.projects) {
    const t = p.tasks.find((x) => x.id === id); if (t) return { p, kind: 'task', item: t };
    const s = p.logSources.find((x) => x.id === id); if (s) return { p, kind: 'source', item: s };
  }
  return null;
}

function stateFor(id) {
  const f = find(id);
  if (!f) return { type: 'state', missing: true };
  const info = f.kind === 'task' ? taskInfo(id) : null;
  return {
    type: 'state', theme: DB.settings.theme, project: f.p.name,
    item: { id, name: f.item.name, kind: f.kind, type: f.kind === 'task' ? 'task' : f.item.type, state: info ? info.state : f.item.running ? 'ready' : 'stopped', port: info?.port || null },
    def: f.kind === 'source' ? sourceDef(f.p, f.item) : null,
    searchable: f.kind === 'source' && SEARCHABLE.has(f.item.type),
  };
}

const push = (id) => api().logsToWindow(id, stateFor(id));
const pushAll = () => { for (const id of open()) push(id); };

function remember(id, on) {
  const list = open().filter((x) => x !== id);
  if (on) list.push(id);
  DB.settings.logWindows = list; saveDB();
}

export async function startItem(id) {
  const f = find(id); if (!f) return;
  const res = f.kind === 'task' ? await api().taskStart(taskDef(f.p, f.item)) : await api().logsSourceStart(sourceDef(f.p, f.item));
  if (!res.ok) { notify(res.error, 'error', 8000); api().logsToWindow(id, { type: 'error', message: res.error }); return; }
  if (f.kind === 'source') { f.item.running = true; saveDB(); }
  if (S.page === 'tasks') renderPage();
  renderStatusBar(); push(id);
}

export async function stopItem(id) {
  const f = find(id); if (!f) return;
  if (f.kind === 'task') await api().taskStop(id);
  else { await api().logsSourceStop(id); f.item.running = false; saveDB(); }
  if (S.page === 'tasks') renderPage();
  push(id);
}

async function onMessage(m) {
  if (m.type === 'hello') { if (!open().includes(m.id)) remember(m.id, true); return push(m.id); }
  if (m.type === 'start') return startItem(m.id);
  if (m.type === 'stop') return stopItem(m.id);
  if (m.type === 'window-closed') return remember(m.id, false);
  if (m.type === 'dock') {
    remember(m.id, false);
    const f = find(m.id); if (!f) return;
    S.projectId = f.p.id; S.tasks.id = m.id;
    setPage('tasks');
  }
}

export function popOutLogs(id) {
  const f = find(id); if (!f) return;
  remember(id, true);
  api().openLogsWindow(id, `${f.item.name} — logs`);
}

export function initLogWindows() {
  api().onLogsMessage(onMessage);
  // A log source that ended by itself (ssh dropped, command exited).
  api().onLogSourceState(({ id, running }) => {
    const f = find(id); if (!f || f.kind !== 'source' || f.item.running === running) return;
    f.item.running = running; saveDB();
    if (S.page === 'tasks') renderPage();
    push(id);
  });
  onAfterSave(pushAll);       // renames, settings changes
  onTasksChanged((what) => { if (what.task && open().includes(what.task)) push(what.task); });
  // Reopen the windows that were open when the app closed.
  const ids = open().filter((id) => find(id));
  if (ids.length !== open().length) { DB.settings.logWindows = ids; saveDB(); }
  for (const id of ids) api().openLogsWindow(id, `${find(id).item.name} — logs`);
}

export const logWindowActions = {
  'logs-pop-out'(d) { popOutLogs(d.id); },
};
