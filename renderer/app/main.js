// Main window entry point (index.html).
import { resetEdits, track } from './edits.js';
import { initMcp } from './mcp.js';
import { $ } from '../shared/html.js';
import { DB, S, loadDB, flushDB, hasPendingSave, restoreTabs, currentProject, onAfterSave } from './store.js';
import { ensureProjectSpecs } from './openapi/registry.js';
import { loadSecretsStatus } from './actions/index.js';
import { applyAppearance, applyAiSetting, proxyStatusItem, initStreams, initRepoSync, checkConfig, initNotesWindow, openSide, initLogWindows, initLogWatch, initOtel } from './actions/index.js';
import { onNotificationsChanged, notify } from '../shared/notify.js';
import { renderStatusBar, renderPage, registerStatusItem } from './views/index.js';
import { initTasks, onTasksChanged, taskInfo } from './tasks.js';
import { refreshLogView, stateChip } from './views/tasks.js';
import { loadHistory, historyEntries } from './history.js';
import { loadTimings } from './timings.js';
import { renderAll } from './views/index.js';
import { wireEvents } from './events.js';

// Don't lose the last 250 ms of edits when the window closes.
window.addEventListener('beforeunload', () => { if (hasPendingSave()) flushDB(); });

wireEvents();
const [{ secretsUnreadable }] = await Promise.all([loadDB(), loadHistory()]);
resetEdits(); onAfterSave(() => track()); // undo / redo of edits (edits.js)
initMcp(); // the MCP server's tools (mcp.js), and the server itself if it's switched on
await loadTimings(historyEntries());
restoreTabs();
applyAppearance();
applyAiSetting();
loadSecretsStatus();
onNotificationsChanged(renderStatusBar);
// Tasks: status bar summary, and the Tasks page follows state changes / new log lines.
initTasks();
registerStatusItem(proxyStatusItem);
initStreams();
initRepoSync();
initNotesWindow(openSide);
initLogWindows();
initLogWatch();
initOtel();
checkConfig();
registerStatusItem(() => {
  const p = currentProject(); if (!p?.tasks.length) return '';
  const states = p.tasks.map((t) => taskInfo(t.id).state);
  const shown = states.find((s) => s === 'failed') || states.find((s) => s === 'starting') || (states.includes('ready') ? 'ready' : 'stopped');
  const running = states.filter((s) => s === 'ready' || s === 'starting').length;
  return `<button class="status-item" data-action="open-tasks" title="Tasks & logs">${stateChip(shown)} ${running}/${p.tasks.length} task${p.tasks.length === 1 ? '' : 's'}</button>`;
});
onTasksChanged(({ log, task }) => {
  if (task !== undefined || !log) renderStatusBar();
  if (S.page !== 'tasks') return;
  const typing = document.activeElement?.closest?.('#page-panel') && document.activeElement.matches('input, textarea, select');
  if (log) refreshLogView(); else if (!typing) { renderPage(); refreshLogView(); }
});
if (secretsUnreadable) notify(`${secretsUnreadable} saved secret(s) couldn't be decrypted here (the data was encrypted on another computer or for another user account) and were cleared: re-enter them, or restore a backup that includes secrets`, 'error', 15000);
S.sidebarMode = DB.settings.sidebarMode || 'projects';
if (DB.settings.sidebarWidth) $('sidebar').style.width = DB.settings.sidebarWidth + 'px';
renderAll();
if (await ensureProjectSpecs(currentProject())) renderAll();
