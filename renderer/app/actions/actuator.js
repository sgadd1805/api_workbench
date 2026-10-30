// Spring Boot Actuator page: load an endpoint, change logger levels (remembering the old ones so they
// can be put back), and create requests from /actuator/mappings.
import { notify } from '../../shared/notify.js';
import { S, saveDB, currentProject, newReq, addRequest, addFolder, uid } from '../store.js';
import { buildRequest } from '../http.js';
import { activeVars, resolve } from '../vars.js';
import { mappingRows, isInternalMapping, requestForMapping, pathVariables, actuatorBaseFor } from '../actuator.js';
import { renderPage, renderAll } from '../views/index.js';
import { openModal } from '../modal.js';
import { setPage } from './core.js';

const A = () => S.actuator;
const ENDPOINT = { health: 'health', env: 'env', mappings: 'mappings', loggers: 'loggers' };

// A call to the Actuator with the project's auth / environment / network settings. → { ok, status, json | error }
async function call(path, { method = 'GET', body } = {}) {
  const p = currentProject(); if (!p) return { ok: false, error: 'Select a project first' };
  const r = newReq({ method, url: `${A().base.replace(/\/+$/, '')}/${path}`, headers: [{ k: 'Accept', v: 'application/json', on: true }], body: body !== undefined ? { type: 'json', text: JSON.stringify(body), form: [] } : undefined });
  const { missingVars, ...wire } = buildRequest({ p, f: null, r });
  if (missingVars.length) return { ok: false, error: `{{${missingVars.join('}}, {{')}}} isn't defined in the active environment` };
  const res = await window.electronAPI.doFetch({ id: uid(), ...wire, body: wire.body || undefined });
  if (!res.ok) return { ok: false, error: res.error };
  if (res.status === 204) return { ok: true, status: 204, json: null };
  if (res.status >= 400) return { ok: false, error: `HTTP ${res.status} from ${wire.url}${res.status === 404 ? ' — is this endpoint exposed (management.endpoints.web.exposure.include)?' : res.status === 401 || res.status === 403 ? ' — check the project\'s auth' : ''}` };
  try { return { ok: true, status: res.status, json: JSON.parse(res.body) }; } catch { return { ok: false, error: `${wire.url} didn't answer with JSON (is that the Actuator address?)` }; }
}

async function load(tab = A().tab) {
  if (!A().base.trim()) return notify('Enter the Actuator address', 'error');
  Object.assign(A(), { loading: true, error: '' });
  renderPage();
  const res = await call(ENDPOINT[tab]);
  Object.assign(A(), { loading: false, error: res.ok ? '' : res.error });
  if (res.ok) A().data[tab] = res.json;
  renderPage();
}

async function setLevel(name, level) {
  const before = (A().data.loggers?.loggers || {})[name]?.configuredLevel ?? null;
  const res = await call(`loggers/${encodeURIComponent(name)}`, { method: 'POST', body: { configuredLevel: level || null } });
  if (!res.ok) { notify(res.error, 'error', 8000); return false; }
  // Remember the level from before the first change this session, for Reset all.
  if (!(name in A().changed)) A().changed[name] = before;
  if ((A().changed[name] ?? null) === (level || null)) delete A().changed[name];
  return true;
}

// Default base: the project's actuatorBase, a running task's port, or the environment's baseUrl.
function defaultBase(p) {
  if (p.actuatorBase) return p.actuatorBase;
  const base = activeVars(p).baseUrl;
  return base ? actuatorBaseFor(resolve(base, activeVars(p))) || '{{baseUrl}}/actuator' : '';
}

export const actuatorActions = {
  'open-actuator'(d) {
    const p = currentProject(); if (!p) return notify('Select a project first', 'error');
    if (d?.port) A().base = `http://localhost:${d.port}/actuator`;
    else if (!A().base || A().projectId !== p.id) A().base = defaultBase(p);
    A().projectId = p.id;
    setPage('actuator');
    if (A().base) load();
  },
  'act-load'() { const p = currentProject(); if (p) { p.actuatorBase = A().base; saveDB(); } A().data = {}; load(); },
  'act-tab'(d) { A().tab = d.tab; A().filter = ''; if (!A().data[d.tab] && A().base) load(d.tab); else renderPage(); },
  async 'act-reset-all'() {
    const entries = Object.entries(A().changed);
    let ok = 0;
    for (const [name, level] of entries) { const res = await call(`loggers/${encodeURIComponent(name)}`, { method: 'POST', body: { configuredLevel: level } }); if (res.ok) { ok++; delete A().changed[name]; } }
    notify(`Put ${ok} of ${entries.length} logger(s) back`, ok === entries.length ? 'info' : 'error');
    load('loggers');
  },
  async 'act-set-new'() {
    const name = document.getElementById('act-new-logger')?.value.trim(), level = document.getElementById('act-new-level')?.value;
    if (!name) return notify('Enter a logger name (a package or class)', 'error');
    if (await setLevel(name, level)) { notify(`${name} → ${level}`); load('loggers'); }
  },
  'act-create'() {
    const p = currentProject(); const d = A().data.mappings; if (!p || !d) return;
    const q = A().filter.trim().toLowerCase();
    const shown = mappingRows(d).filter((m) => (A().showInternal || !isInternalMapping(m)) && (!q || `${m.path} ${m.handler} ${m.methods.join(' ')}`.toLowerCase().includes(q)));
    const picked = A().picked.size ? shown.filter((m) => A().picked.has(m.methods.join(',') + ' ' + m.path)) : shown;
    const n = picked.reduce((k, m) => k + m.methods.length, 0);
    openModal({ title: `Create ${n} request${n === 1 ? '' : 's'}`, ok: 'Create', fields: [
      { key: 'group', label: 'Put them in', type: 'select', value: 'controller', options: [{ value: 'controller', label: 'A folder per controller' }, { value: 'one', label: 'One folder: "Actuator mappings"' }, { value: 'root', label: 'Project root' }] }],
    hint: 'Existing requests with the same method and URL are skipped. {{baseUrl}} and path variables are added to the active environment when missing.',
    onOk: (v) => {
      const existing = new Set([...p.requests, ...p.folders.flatMap((f) => f.requests)].map((r) => `${r.method} ${r.url}`));
      const folders = new Map();
      const folderFor = (name) => { if (v.group === 'root') return null; const n2 = v.group === 'one' ? 'Actuator mappings' : name || 'Other'; if (!folders.has(n2)) folders.set(n2, p.folders.find((f) => f.name === n2) || addFolder(p, n2)); return folders.get(n2); };
      let made = 0;
      const vars = new Set();
      for (const m of picked) for (const method of m.methods) {
        const fields = requestForMapping(m, method);
        if (existing.has(`${method} ${fields.url}`)) continue;
        addRequest(p, folderFor(m.controller), newReq(fields)); made++;
        pathVariables(m.path).forEach((x) => vars.add(x));
      }
      // Make sure {{baseUrl}} and the path variables exist in the active environment.
      const env = p.envs.find((e) => e.id === p.activeEnv);
      if (env) for (const k of ['baseUrl', ...vars]) if (!env.vars.some((x) => x.k === k)) env.vars.push({ k, v: k === 'baseUrl' ? A().base.replace(/\/actuator\/?$/, '') : '', on: true });
      S.projectOpen[p.id] = true; for (const f of folders.values()) S.folderOpen[f.id] = true;
      A().picked = new Set();
      saveDB(); renderAll();
      notify(`Created ${made} request${made === 1 ? '' : 's'}${env ? '' : ' (add an environment with baseUrl)'}`);
    } });
  },
};

export async function onActuatorChange(el) {
  if (el.classList.contains('act-level')) {
    const name = el.dataset.logger, level = el.value;
    if (await setLevel(name, level)) { notify(`${name} → ${level || 'inherit'}`); load('loggers'); }
    return true;
  }
  if (el.id === 'act-internal') { A().showInternal = el.checked; renderPage(); return true; }
  if (el.id === 'act-only-configured') { A().onlyConfigured = el.checked; renderPage(); return true; }
  if (el.classList.contains('act-pick')) { if (el.checked) A().picked.add(el.dataset.key); else A().picked.delete(el.dataset.key); renderPage(); return true; }
  if (el.id === 'act-pick-all') {
    for (const box of document.querySelectorAll('.act-pick')) { if (el.checked) A().picked.add(box.dataset.key); else A().picked.delete(box.dataset.key); }
    renderPage(); return true;
  }
  return false;
}

export function onActuatorInput(el) {
  if (el.id === 'act-base') { A().base = el.value; return true; }
  if (el.id === 'act-filter') {
    A().filter = el.value; const at = el.selectionStart;
    renderPage(); const again = document.getElementById('act-filter'); again?.focus(); again?.setSelectionRange(at, at);
    return true;
  }
  return el.id === 'act-new-logger';
}
