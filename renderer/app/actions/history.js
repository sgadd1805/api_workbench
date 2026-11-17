// History panel and entry page.
import { copyText, flashDone } from '../../shared/html.js';
import { notify } from '../../shared/notify.js';
import { isJson } from '../../shared/json.js';
import { DB, S, saveDB, findReq, project, currentProject, addRequest, newReq, activeEnv, effectiveAuth } from '../store.js';
import { historyEntry, deleteHistoryEntry, clearHistory, recordHistory, recordReplay } from '../history.js';
import { send, buildRequest, newSendId } from '../http.js';
import { getToken } from '../tokens.js';
import { attachValidation } from '../verify.js';
import { wireFromEntry, redactedHeaders, fillRedacted, applyChange, describeChange, compareResponses, REDACTED_HEADER, savableHeaders, renewCorrelation } from '../replay.js';
import { newCorrelation } from '../tasks.js';
import { toCurl } from '../curl.js';
import { renderAll, renderSidebar, renderPage } from '../views/index.js';
import { openModal } from '../modal.js';
import { openReq, setPage } from './core.js';

const current = () => historyEntry(S.history.id);

// A saved request that reproduces exactly what was sent (resolved URL, final headers, body).
function requestFromEntry(e, name) {
  const body = e.request.parts?.length
    ? { type: 'multipart', text: '', form: e.request.parts.map((p) => (p.file != null ? { k: p.name, v: p.file, on: true, file: true, ...(p.contentType && { type: p.contentType }) } : { k: p.name, v: p.value ?? '', on: true })) }
    : e.request.file ? { type: 'binary', text: '', form: [], file: e.request.file }
    : e.request.body
    ? { type: isJson(e.request.body) ? 'json' : 'raw', text: e.request.body, form: [] }
    : { type: 'none', text: '', form: [] };
  return newReq({
    name, method: e.method, url: e.url, body, auth: { type: 'none' },
    headers: savableHeaders(e.request.headers),
  });
}

export const historyActions = {
  'sidebar-mode'(d) {
    S.sidebarMode = d.mode; DB.settings.sidebarMode = d.mode; saveDB();
    renderSidebar();
    if (d.mode === 'history') document.getElementById('history-search')?.focus();
  },
  'history-open'(d) {
    if (S.history.id !== d.id) Object.assign(S.history.replay, { name: '', value: '', remove: false, open: [] });
    S.history.id = d.id; S.history.resTab = 'body'; setPage('history');
  },
  'replay-send'() { replaySend(); },
  'replay-gap'(d) { const R = S.history.replay; R.open = [...R.open, d.gap]; renderPage(); },
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
    copyText(toCurl({ method: e.method, url: e.url, headers: e.request.headers || {}, body: e.request.body, bodyParts: e.request.parts, bodyFile: e.request.file })); flashDone(el);
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

// The saved request's headers as they'd be sent now (its auth, a token source's token), to fill in the
// credentials History blanked out.
async function freshHeaders(loc) {
  const auth = effectiveAuth(loc);
  const token = auth.type === 'token' ? (await getToken(auth.sourceId, loc.p)).token : undefined;
  return buildRequest(loc, { token }).headers;
}

// "Send again with one change": the recorded request with one header / query parameter / body field changed,
// or the saved request in another environment; compared with the recorded response.
async function replaySend() {
  const e = current(), R = S.history.replay; if (!e || R.running) return;
  const loc = e.reqId && findReq(e.reqId);
  const p = loc?.p || project(e.projectId);
  const change = { kind: R.kind, name: R.name.trim(), value: R.value, remove: R.remove, envId: R.envId };
  const notes = [];
  let res, entry, label;
  R.running = true; R.result = null; R.open = []; renderPage();
  try {
    if (change.kind === 'env') {
      const env = p?.envs.find((x) => x.id === change.envId) || activeEnv(p);
      if (!loc || !env) throw new Error(loc ? 'Pick an environment' : 'The request was deleted, so it can\'t be sent in another environment');
      label = describeChange(change, env.name);
      res = await attachValidation(loc, await send(loc, undefined, { env }));
      entry = recordHistory(loc, res, { envId: env.id, extra: { replayOf: e.id, change: label } });
    } else {
      const wire = renewCorrelation(wireFromEntry(e), newCorrelation());
      const blanked = redactedHeaders(wire);
      if (blanked.length) {
        const missing = fillRedacted(wire, loc ? await freshHeaders(loc) : {});
        const filled = blanked.filter((k) => !missing.includes(k));
        if (filled.length) notes.push(`History had blanked ${filled.join(', ')}; filled in from the saved request's auth as it is now`);
        if (missing.length) notes.push(`History had blanked ${missing.join(', ')}, which ${loc ? 'the saved request doesn\'t set now' : 'can\'t be filled in (the request was deleted)'}; sent without ${missing.length === 1 ? 'it' : 'them'}`);
      }
      if (REDACTED_HEADER.test(wire.body) || /\[REDACTED\]/.test(e.url)) notes.push('History removed secrets from the recorded URL or body ([REDACTED]); they were sent as recorded');
      const changed = applyChange(wire, change);
      if (changed.error) throw new Error(changed.error);
      label = describeChange(change);
      const env = activeEnv(p);
      const t0 = performance.now();
      const raw = await window.electronAPI.doFetch({ id: newSendId(), ...changed.wire, network: env?.network || null,
        timeoutMs: Math.max(0, Number(loc?.r.options.timeoutSec ?? 60) || 0) * 1000, redirect: loc && !loc.r.options.followRedirects ? 'manual' : 'follow' });
      const requestData = { ...changed.wire, headers: raw.sentHeaders || changed.wire.headers };
      res = raw.ok ? { ...raw, time: Math.round(performance.now() - t0), requestData } : { error: raw.error, requestData };
      if (loc) res = await attachValidation(loc, res);
      entry = recordReplay(e, res, { change: label });
    }
  } catch (err) {
    R.running = false; renderPage();
    return notify(String(err?.message || err), 'error');
  }
  R.running = false;
  R.result = { baseId: e.id, entryId: entry?.id || null, res, change: label, notes, cmp: res.error ? null : compareResponses(e.response, res) };
  if (S.page === 'history') renderPage();
  if (S.sidebarMode === 'history') renderSidebar();
}

// Inputs of the "Send again with one change" form. → true when handled
export function onReplayInput(el) {
  const R = S.history.replay;
  if (el.id === 'replay-name') { R.name = el.value; return true; }
  if (el.id === 'replay-value') { R.value = el.value; return true; }
  return false;
}
export function onReplayChange(el) {
  const R = S.history.replay;
  if (el.id === 'replay-kind') { R.kind = el.value; R.name = ''; R.value = ''; R.remove = false; renderPage(); return true; }
  if (el.id === 'replay-remove') { R.remove = el.checked; renderPage(); return true; }
  if (el.id === 'replay-env') { R.envId = el.value; return true; }
  return onReplayInput(el);
}
