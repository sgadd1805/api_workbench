// Navigation, tabs and sending, used by several action groups and by events.js.
import { notify } from '../../shared/notify.js';
import { DB, S, saveDB, findReq, activeTab, activateTab, closeTab, tabFor, addRequest, currentProject } from '../store.js';
import { recordHistory } from '../history.js';
import { ensureProjectSpecs } from '../openapi/registry.js';
import { attachValidation } from '../verify.js';
import { loadGit, loadRepo } from './git.js';
import { waitForTasks } from './tasks.js';
import { send, newSendId, cancelSend } from '../http.js';
import { renderAll } from '../views/index.js';
import { sendStreamRequest } from './protocols.js';
import { LATE } from '../logwatch.js';

// Opens the request in its tab (creating the tab if needed) and shows the editor.
export function openReq(id) {
  if (!activateTab(id)) return;
  S.page = 'request';
  renderAll();
  // The Spec tab and its badge need the project's spec documents; render again once they've loaded.
  ensureProjectSpecs(findReq(id)?.p).then((loaded) => { if (loaded && S.req?.id === id) renderAll(); });
  const { sideOpen, sideTab } = DB.settings.layout;
  if (sideOpen && sideTab === 'git') { loadRepo(); loadGit(id); }
}

// Assertions, snapshot and spec checks on a finished send (verify.js), re-exported for the action groups.
export { attachValidation };

export function setPage(page) { S.page = page; renderAll(); }

export function closeReqTab(id) {
  const tab = closeTab(id);
  if (tab?.sending) cancelSend(tab.sending);
  renderAll();
}

// Ctrl+Tab / Ctrl+Shift+Tab
export function cycleTab(step) {
  if (!S.tabs.length) return;
  const i = S.tabs.indexOf(activeTab());
  openReq(S.tabs[(i + step + S.tabs.length) % S.tabs.length].id);
}

// "+" in the tab bar: a new request next to the active one (same folder), else in the current project.
export function newRequestTab() {
  const loc = S.req && findReq(S.req.id);
  const p = loc?.p || currentProject();
  if (!p) return notify('Create a project first', 'error');
  const r = addRequest(p, loc?.f || null);
  if (loc?.f) S.folderOpen[loc.f.id] = true;
  S.projectOpen[p.id] = true;
  saveDB(); openReq(r.id);
}

// Sends the active tab's request. The result lands in that tab even if you've switched away meanwhile.
export async function sendCurrent() {
  const loc = S.req && findReq(S.req.id), tab = activeTab();
  if (!loc || !tab || tab.sending) return;
  if (sendStreamRequest()) return; // WebSocket / SSE: connect, or send the composed message
  const id = newSendId();
  tab.sending = id; renderAll();
  await waitForTasks(loc.p); // a local service that's still starting
  const ranFrom = Date.now();
  const res = await attachValidation(loc, await send(loc, id));
  // For log watch: which flagged lines arrived while this ran (re-checked once late lines are in).
  Object.assign(res, { ranFrom, ranTo: Date.now() });
  setTimeout(() => { if (activeTab()?.response === res && S.page === 'request') renderAll(); }, LATE + 200);
  if (tab.sending === id) tab.sending = null;
  recordHistory(loc, res);
  tab.response = res; tab.historyBase = 1;
  tab.unseen = S.req?.id !== tab.id && !!tabFor(tab.id);
  renderAll();
}

export function cancelCurrent() { const tab = activeTab(); if (tab?.sending) cancelSend(tab.sending); }

