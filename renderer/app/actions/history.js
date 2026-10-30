// History panel and entry page.
import { copyText, flashDone } from '../../shared/html.js';
import { notify } from '../../shared/notify.js';
import { isJson } from '../../shared/json.js';
import { DB, S, saveDB, findReq, project, currentProject, addRequest, newReq } from '../store.js';
import { historyEntry, deleteHistoryEntry, clearHistory } from '../history.js';
import { toCurl } from '../curl.js';
import { renderAll, renderSidebar } from '../views/index.js';
import { openModal } from '../modal.js';
import { openReq, setPage } from './core.js';

const current = () => historyEntry(S.history.id);

// A saved request that reproduces exactly what was sent (resolved URL, final headers, body).
function requestFromEntry(e, name) {
  const body = e.request.body
    ? { type: isJson(e.request.body) ? 'json' : 'raw', text: e.request.body, form: [] }
    : { type: 'none', text: '', form: [] };
  return newReq({
    name, method: e.method, url: e.url, body, auth: { type: 'none' },
    headers: Object.entries(e.request.headers || {}).map(([k, v]) => ({ k, v, on: true })),
  });
}

export const historyActions = {
  'sidebar-mode'(d) {
    S.sidebarMode = d.mode; DB.settings.sidebarMode = d.mode; saveDB();
    renderSidebar();
    if (d.mode === 'history') document.getElementById('history-search')?.focus();
  },
  'history-open'(d) { S.history.id = d.id; S.history.resTab = 'body'; setPage('history'); },
  'history-open-req'() { const e = current(); if (e && findReq(e.reqId)) openReq(e.reqId); },
  'history-save-as'() {
    const e = current(); if (!e) return;
    if (!DB.projects.length) return notify('Create a project first', 'error');
    const preferred = (findReq(e.reqId)?.p || project(e.projectId) || currentProject() || DB.projects[0]).id;
    openModal({ title: 'Save as request', ok: 'Save', hint: 'Saves the URL, headers and body exactly as sent (variables already resolved, auth as a header).',
      fields: [
        { key: 'name', label: 'Name', value: `${e.reqName} (${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` },
        { key: 'project', label: 'Project', type: 'select', options: DB.projects.map((p) => ({ value: p.id, label: p.name })), value: preferred }],
      onOk: (v) => {
        const p = project(v.project); if (!p) return;
        const r = addRequest(p, null, requestFromEntry(e, v.name.trim() || e.reqName));
        S.projectOpen[p.id] = true; saveDB(); openReq(r.id);
      } });
  },
  'history-curl'(_d, el) {
    const e = current(); if (!e) return;
    copyText(toCurl({ method: e.method, url: e.url, headers: e.request.headers || {}, body: e.request.body })); flashDone(el);
  },
  'history-delete'() {
    const e = current(); if (!e) return;
    deleteHistoryEntry(e.id); S.history.id = null; setPage('request');
  },
  'history-clear'() {
    openModal({ title: 'Clear all history?', ok: 'Clear', hint: 'This also clears each request\'s History tab.',
      fields: [{ key: 'confirm', label: 'Type CLEAR to confirm' }],
      onOk: (v) => {
        if (v.confirm.trim().toUpperCase() !== 'CLEAR') return;
        clearHistory(); if (S.page === 'history') S.page = 'request';
        renderAll(); notify('History cleared');
      } });
  },
};
