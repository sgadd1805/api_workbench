// Getting requests in and out: cURL import, collection files, captured traffic, and the login session.
import { recordVar, secretLooking } from '../varlog.js';
import { notify } from '../../shared/notify.js';
import { DB, S, saveDB, currentProject, findReq, addFolder, addRequest, addProject, addEnv, activeEnv, newReq, tabFor } from '../store.js';
import { activeVars } from '../vars.js';
import { templatize, buildFlow, checksFor } from '../flow.js';
import { parseCurl } from '../curl.js';
import { buildRequest, mergeCookies } from '../http.js';
import { exportNative, exportPostman, importCollection } from '../collection.js';
import { captureLabel, capturedOf } from '../capture.js';
import { renderAll } from '../views/index.js';
import { openModal } from '../modal.js';
import { openReq } from './core.js';
import { runnerActions } from './runner.js';

const targetProject = () => currentProject() || DB.projects[0];
const fileName = (s) => s.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'collection';

export const ioActions = {
  'import-curl'() {
    openModal({ title: 'Import cURL', ok: 'Import', fields: [{ key: 'cmd', label: 'Paste cURL command', type: 'textarea' }],
      onOk: (v) => {
        const p = targetProject(); if (!p) return alert('Create a project first');
        const r = addRequest(p, null, newReq(parseCurl(v.cmd)));
        S.projectOpen[p.id] = true; saveDB(); openReq(r.id);
      } });
  },

  async 'import-collection'() {
    const file = await window.electronAPI.openTextFile();
    if (!file.ok) { if (!file.canceled) notify(file.error, 'error'); return; }
    try {
      const p = importCollection(file.content);
      DB.projects.push(p);
      S.projectOpen[p.id] = true; S.projectId = p.id;
      saveDB(); renderAll();
      const count = p.requests.length + p.folders.reduce((n, f) => n + f.requests.length, 0);
      notify(`Imported "${p.name}": ${count} request${count === 1 ? '' : 's'}`);
    } catch (err) { notify('Import failed: ' + err.message, 'error', 8000); }
  },

  'export-collection'() {
    const p = currentProject(); if (!p) return;
    openModal({ title: 'Export ' + p.name, ok: 'Export…', hint: 'The cookie jar, attached specs and code folder are never exported.',
      fields: [{ key: 'format', label: 'Format', type: 'select', value: 'native',
        options: [{ value: 'native', label: 'This app (round-trips everything)' }, { value: 'postman', label: 'Postman collection v2.1 (active environment as variables)' }] },
        { key: 'secrets', label: 'Secrets (auth tokens and passwords, 🔒 variables, certificate passphrases)', type: 'select', value: 'omit',
          options: [{ value: 'omit', label: 'Leave them out (recommended for sharing)' }, { value: 'include', label: 'Include secrets' }] }],
      onOk: async (v) => {
        const opts = { includeSecrets: v.secrets === 'include' };
        const content = v.format === 'postman' ? exportPostman(p, opts) : exportNative(p, opts);
        const res = await window.electronAPI.saveTextFile(`${fileName(p.name)}${v.format === 'postman' ? '.postman_collection' : ''}.json`, content);
        if (res.ok) notify('Exported to ' + res.filePath); else if (!res.canceled) notify(res.error, 'error');
      } });
  },
};

// Toolbar "→ Requests": pick captured login-window calls and save them into the current project.
export async function importCapture() {
  const p = targetProject(); if (!p) return notify('Create a project first', 'error');
  const entries = await window.electronAPI.harEntries();
  if (!entries.length) return notify('Nothing captured yet: open the login window and use the site first', 'error');
  openModal({ title: `Save captured requests to "${p.name}"`, ok: 'Add requests', wide: true, fields: [
    { key: 'pick', label: 'Captured XHR/Fetch calls', type: 'checklist', options: entries.map((e) => ({ value: String(e.index), label: captureLabel(e), checked: e.status < 400 })) },
    { key: 'folder', label: 'Into folder (empty = project root)', value: 'Captured' }],
  onOk: (v) => {
    const chosen = entries.filter((e) => v.pick.includes(String(e.index)));
    if (!chosen.length) return;
    const f = v.folder.trim() ? (p.folders.find((x) => x.name === v.folder.trim()) || addFolder(p, v.folder.trim())) : null;
    const reqs = chosen.map((e) => { const t = templatize(e, captureContext(p)); addCaptureVars(p, t); return addRequest(p, f, t.req); });
    S.projectOpen[p.id] = true; if (f) S.folderOpen[f.id] = true;
    saveDB(); openReq(reqs[0].id);
    notify(`Added ${reqs.length} request${reqs.length === 1 ? '' : 's'}`);
  } });
}

const CAPTURE_FOLDER = 'Captured';
const captureContext = (p) => ({ vars: activeVars(p), projectAuth: p.auth, secretNames: (activeEnv(p)?.vars || []).filter((v) => v.secret).map((v) => v.k) });
// Variables a templatized capture refers to, added to the active environment (created if there is none).
// Values already there are kept; a captured secret (a bearer token) only fills an empty one.
function addCaptureVars(p, { newVars = {}, secretVars = {} }, { overwrite = false } = {}) {
  const env = activeEnv(p) || addEnv(p, 'Captured');
  p.activeEnv = env.id;
  const put = (k, v, secret) => {
    const row = env.vars.find((x) => x.k === k);
    if (!row || overwrite || !row.v) recordVar({ p, env, name: k, before: row?.v, value: v, secret: secret || !!row?.secret, source: 'captured from the login window', kind: 'capture' });
    if (!row) env.vars.push({ k, v, on: true, ...(secret && { secret: true }) });
    else if (overwrite || !row.v) { row.v = v; row.on = true; }
  };
  for (const [k, v] of Object.entries(newVars)) put(k, v, false);
  for (const [k, v] of Object.entries(secretVars)) put(k, v, true);
}
// The same call already saved in a folder (method, URL and body), so opening it twice doesn't add a copy.
export const sameCall = (a, b) => a.method === b.method && a.url === b.url && (a.body?.text || '') === (b.body?.text || '');

// Session toolbar → Network list: one captured login-window call opened in the app as a request (in the
// current project's "Captured" folder), with the response the page got shown in its tab. Nothing is resent.
export async function openCapture(index) {
  const [summary, detail] = await Promise.all([window.electronAPI.harEntries().then((list) => list.find((e) => e.index === index)), window.electronAPI.harEntry(index)]);
  if (!summary || !detail) return notify('That call is no longer in the capture (it was cleared)', 'error');
  const p = targetProject() || addProject('Captured traffic');
  const f = p.folders.find((x) => x.name === CAPTURE_FOLDER) || addFolder(p, CAPTURE_FOLDER);
  const t = templatize(summary, captureContext(p));
  const existing = f.requests.find((r) => sameCall(r, t.req));
  if (!existing) addCaptureVars(p, t);
  const r = existing || addRequest(p, f, t.req);
  r.captured = capturedOf(detail.response, Date.parse(summary.at) || Date.now());
  S.projectOpen[p.id] = true; S.folderOpen[f.id] = true; S.projectId = p.id;
  saveDB(); openReq(r.id);
  const tab = tabFor(r.id);
  if (tab && !tab.sending) {
    const res = detail.response;
    tab.response = { ...res, time: res.time, captured: true, requestData: detail.request, ...(res.error && !res.status && { error: res.error }) };
    renderAll();
  }
  notify(`${existing ? 'Opened' : 'Added'} ${r.method} ${r.name} in ${p.name} / ${CAPTURE_FOLDER}, with the captured response. Send it to replay from the app.`, 'info', 6000);
}

// Session toolbar → Network list → Save as flow: the chosen calls, in the order they happened, as a folder that
// replays in the collection runner, with the values passed between them linked (flow.js buildFlow).
export async function saveCaptureFlow(indexes) {
  const all = await window.electronAPI.harEntries();
  const chosen = [...new Set(indexes)].sort((a, b) => a - b).map((i) => all.find((e) => e.index === i)).filter(Boolean);
  if (!chosen.length) return notify('Those calls are no longer in the capture (it was cleared)', 'error');
  const details = await Promise.all(chosen.map((e) => window.electronAPI.harEntry(e.index)));
  const p = targetProject() || addProject('Captured traffic');
  const calls = chosen.map((summary, i) => ({ summary, detail: details[i] }));
  const flow = buildFlow(calls, captureContext(p));
  // Named by the templated path, so a captured id doesn't stay in the name: 4. GET /orders/{{orderId}}
  const shownPath = (r) => r.url.replace(/^\{\{[^}]+\}\}/, '').replace(/^https?:\/\/[^/]+/, '').split('?')[0] || '/';
  openModal({ title: `Save ${chosen.length} call${chosen.length === 1 ? '' : 's'} as a flow in "${p.name}"`, ok: 'Save flow', wide: true,
    hint: 'A folder with the calls in order. Values one response hands to a later request (tokens, ids, CSRF values) become variables with extract rules, hosts become {{baseUrl}}-style variables, and browser-only headers are dropped. Run the folder in the collection runner to replay it.',
    fields: [{ key: 'name', label: 'Folder name', value: `Flow: ${shownPath(flow.requests[0])}${chosen.length > 1 ? ` → ${shownPath(flow.requests.at(-1))}` : ''}`.slice(0, 80) },
      { key: 'opts', label: 'Also', type: 'checklist', options: [{ value: 'checks', label: 'Add checks from the captured responses (status, JSON shape, stable fields), so a replay is a regression test', checked: true }] }],
    onOk: (v) => {
      if (v.opts.includes('checks')) calls.forEach((c, i) => { flow.requests[i].assertions = checksFor(c.detail?.response); });
      // Linked credentials (a token, a CSRF value) are secret variables: masked on screen, encrypted on disk.
      const secretLinks = Object.fromEntries(flow.links.filter((l) => secretLooking(l.name) || secretLooking(l.path)).map((l) => [l.name, flow.newVars[l.name]]));
      for (const k of Object.keys(secretLinks)) delete flow.newVars[k];
      addCaptureVars(p, { newVars: flow.newVars, secretVars: { ...flow.secretVars, ...secretLinks } }, { overwrite: true });
      for (const k of Object.keys(secretLinks)) { const row = activeEnv(p)?.vars.find((v) => v.k === k); if (row) row.secret = true; }
      let name = v.name.trim() || 'Captured flow';
      for (let n = 2; p.folders.some((f) => f.name === name); n++) name = `${v.name.trim() || 'Captured flow'} (${n})`;
      const f = addFolder(p, name);
      const width = String(flow.requests.length).length;
      const reqs = flow.requests.map((r, i) => addRequest(p, f, { ...r, captured: capturedOf(calls[i].detail?.response, Date.parse(calls[i].summary.at) || Date.now()), name: `${String(i + 1).padStart(width, '0')}. ${r.method} ${shownPath(r)}`.slice(0, 90) }));
      S.projectOpen[p.id] = true; S.folderOpen[f.id] = true; S.projectId = p.id;
      saveDB(); openReq(reqs[0].id);
      const linked = flow.links.map((l) => `{{${l.name}}}`).join(', ');
      notify(`Saved "${f.name}": ${reqs.length} request${reqs.length === 1 ? '' : 's'}${flow.links.length ? `, linked ${linked}` : ', no values passed between them'}`, 'info', 10000,
        { label: 'Run flow', run: () => runnerActions['open-runner']({ scope: `folder|${f.id}` }) });
    } });
}

// Toolbar "Use session": login window cookies (for the open request's URL) → project cookie jar,
// latest captured bearer token → project auth.
export async function useLoginSession() {
  const p = targetProject(); if (!p) return notify('Create a project first', 'error');
  const loc = S.req && findReq(S.req.id);
  const url = loc && loc.p === p ? buildRequest(loc).url : '';
  const s = await window.electronAPI.loginSession(url);
  if (!s.ok) return notify(s.error, 'error');
  const parts = [];
  if (s.cookies.length) { p.cookies = mergeCookies(p.cookies, s.cookies); parts.push(`${s.cookies.length} cookie${s.cookies.length === 1 ? '' : 's'}`); }
  if (s.token) { p.auth = { type: 'bearer', token: s.token }; parts.push('bearer token'); }
  if (!parts.length) return notify(`No cookies for ${s.target || 'that URL'} and no bearer token in the capture`, 'error', 6000);
  saveDB(); renderAll();
  notify(`"${p.name}" now uses the login session: ${parts.join(' + ')}${s.tokenSource ? ` (token from ${s.tokenSource})` : ''}`, 'info', 7000);
}
