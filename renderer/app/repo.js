// Requests as files in the project's code folder (main/repofiles.js writes / reads the YAML).
// p.repo: { dir (relative to the code folder, default "api-requests"), auto (write on every change and
// offer to reload when the files change), syncedIds (requests last written / read, so a request
// deleted in the repo is deleted here on load, while new local ones stay) }.
// Secrets stay out of the files: literal bearer tokens / passwords and secret variable values are
// left empty; use {{variables}} for them.
import { notify } from '../shared/notify.js';
import { joinPath, relPath, isAbsPath } from '../shared/paths.js';
import { DB, normalizeRequest, findReq, addEnv } from './store.js';

export const DEFAULT_DIR = 'api-requests';
const SECRET_FREE = (s) => !s || /\{\{[^}]+\}\}/.test(s);

// File-name part from a name: lower case, a-z 0-9 and "-" only. Names Windows reserves for devices
// (con, nul, com1 …, even with an extension) get a "-" so the repo can be checked out there.
const slug = (s) => {
  const out = String(s || 'request').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'request';
  return /^(con|prn|aux|nul|com\d|lpt\d)$/.test(out) ? out + '-' : out;
};

// The request-files folder must be a relative folder inside the code folder: an absolute path or one that
// climbs out with ".." (e.g. from a shared api-client.json) would let syncing write and delete files elsewhere.
export const safeRepoSubdir = (dir) => {
  const d = String(dir || '').trim();
  return !!d && !isAbsPath(d) && !/^~/.test(d) && !d.split(/[\\/]+/).some((seg) => seg === '..');
};
export const repoDir = (p) => (p.codeFolder ? joinPath(p.codeFolder, safeRepoSubdir(p.repo?.dir) ? p.repo.dir.trim() : DEFAULT_DIR) : null);

function cleanAuth(auth) {
  const a = { ...auth };
  if (a.type === 'bearer' && !SECRET_FREE(a.token)) a.token = '';
  if (a.type === 'basic' && !SECRET_FREE(a.pass)) a.pass = '';
  return a;
}

// A path inside the code folder is stored relative to it, with "/" (so it works on teammates' machines,
// Windows or not).
const relTo = relPath;
const absFrom = (base, file) => (base && file ? joinPath(base, file) : file);

function requestData(p, f, r, order) {
  const data = {
    id: r.id, name: r.name, ...(r.kind && { kind: r.kind }), method: r.method, url: r.url,
    folder: f?.id || null, order,
    headers: r.headers, body: r.body, auth: cleanAuth(r.auth),
    assertions: r.assertions.filter((a) => a.trim()), extract: r.chain, scripts: r.scripts, options: r.options,
  };
  if (r.spec) data.spec = r.spec;
  if (r.graphql) data.graphql = r.graphql;
  if (r.ws) data.ws = r.ws;
  if (r.snapshot) data.snapshot = r.snapshot;
  if (r.grpc) data.grpc = { ...r.grpc, protoFile: relTo(p.codeFolder, r.grpc.protoFile) };
  return data;
}

// → { project, files: [{ rel, data }] }
export function toRepo(p) {
  const files = [], used = new Set();
  const add = (f, r, i) => {
    const folderPart = f ? slug(f.name) + '/' : '';
    let rel = `${folderPart}${slug(r.name)}.request.yaml`;
    if (used.has(rel)) rel = `${folderPart}${slug(r.name)}-${r.id.slice(-5)}.request.yaml`;
    used.add(rel);
    files.push({ rel, data: requestData(p, f, r, i) });
  };
  p.requests.forEach((r, i) => add(null, r, i));
  for (const f of p.folders) f.requests.forEach((r, i) => add(f, r, i));
  const project = {
    name: p.name,
    folders: p.folders.map((f) => ({ id: f.id, name: f.name })),
    environments: p.envs.map((e) => ({ name: e.name, variables: e.vars.filter((v) => v.k).map((v) => (v.secret ? { name: v.k, secret: true } : { name: v.k, value: v.v })) })),
  };
  return { project, files };
}

// Merges files read from the repo into the project. → { added, updated, removed, envVars }
export function fromRepo(p, { project, requests }) {
  const stats = { added: 0, updated: 0, removed: 0, envVars: 0 };
  // Folders: by id, else by name; created when missing.
  for (const fd of project?.folders || []) {
    if (!p.folders.some((f) => f.id === fd.id)) {
      const byName = p.folders.find((f) => f.name === fd.name);
      if (byName) byName.id = fd.id; else p.folders.push({ id: fd.id, name: fd.name, auth: { type: 'inherit' }, requests: [] });
    }
  }
  // Environments: missing ones and missing variables are added; local values are never overwritten.
  for (const e of project?.environments || []) {
    const env = p.envs.find((x) => x.name === e.name) || addEnv(p, e.name);
    for (const v of e.variables || []) {
      if (!v.name || env.vars.some((x) => x.k === v.name)) continue;
      env.vars.push({ k: v.name, v: v.secret ? '' : String(v.value ?? ''), on: true, ...(v.secret && { secret: true }) });
      stats.envVars++;
    }
  }
  const seen = new Set();
  const placed = [];
  for (const { data } of requests) {
    if (!data?.id || seen.has(data.id)) continue;
    seen.add(data.id);
    const existing = findReq(data.id);
    const local = existing?.p === p ? existing.r : null;
    const r = normalizeRequest({
      ...(local || {}), id: data.id, name: data.name, method: data.method || 'GET', url: data.url || '',
      headers: data.headers || [], body: data.body, assertions: data.assertions || [], chain: data.extract || [], scripts: data.scripts, options: data.options,
      spec: data.spec || null, auth: data.auth || { type: 'inherit' },
    });
    for (const k of ['kind', 'graphql', 'ws', 'snapshot']) if (data[k]) r[k] = data[k]; else delete r[k];
    if (data.grpc) r.grpc = { ...data.grpc, protoFile: absFrom(p.codeFolder, data.grpc.protoFile) }; else delete r.grpc;
    // Keep the local secret when the file has it blanked out.
    if (local && r.auth.type === local.auth.type) {
      if (r.auth.type === 'bearer' && !r.auth.token) r.auth.token = local.auth.token;
      if (r.auth.type === 'basic' && !r.auth.pass) r.auth.pass = local.auth.pass;
    }
    if (local) { Object.keys(local).forEach((k) => { if (!(k in r)) delete local[k]; }); Object.assign(local, r); stats.updated++; } else stats.added++;
    placed.push({ r: local || r, folder: data.folder, order: data.order ?? 0, wasLocal: !!local });
  }
  // Requests deleted in the repo (they were synced before and aren't in the files any more).
  const synced = new Set(p.repo?.syncedIds || []);
  const removeIds = new Set([...synced].filter((id) => !seen.has(id)));
  // Rebuild the containers: synced requests in file order, then the local-only ones.
  const keepLocal = (list) => list.filter((r) => !seen.has(r.id) && !removeIds.has(r.id));
  const before = p.requests.length + p.folders.reduce((n, f) => n + f.requests.length, 0);
  const local = new Map([[null, keepLocal(p.requests)], ...p.folders.map((f) => [f.id, keepLocal(f.requests)])]);
  const containers = new Map([[null, { list: [] }], ...p.folders.map((f) => [f.id, { list: [] }])]);
  for (const x of placed.sort((a, b) => a.order - b.order)) (containers.get(x.folder) || containers.get(null)).list.push(x.r);
  for (const [id, list] of local) containers.get(id).list.push(...list);
  p.requests = containers.get(null).list;
  for (const f of p.folders) f.requests = containers.get(f.id).list;
  const after = p.requests.length + p.folders.reduce((n, f) => n + f.requests.length, 0);
  stats.removed = Math.max(0, before + stats.added - after);
  p.repo = { ...(p.repo || {}), syncedIds: [...seen] };
  return stats;
}

// ── saving / loading / auto-sync ─────────────────────────────────────────────────────────────────
const lastWritten = new Map(); // project id → JSON of what was written

export async function saveToRepo(p, { quietIfSame = false } = {}) {
  const dir = repoDir(p);
  if (!dir) { if (!quietIfSame) notify('Set the project\'s code folder first (Project settings)', 'error'); return null; }
  const out = toRepo(p);
  const key = JSON.stringify(out);
  if (quietIfSame && lastWritten.get(p.id) === key) return null;
  const res = await window.electronAPI.repoWrite({ dir, ...out });
  if (!res.ok) { notify('Saving to the repo failed: ' + res.error, 'error'); return null; }
  lastWritten.set(p.id, key);
  p.repo = { ...(p.repo || {}), syncedIds: out.files.map((f) => f.data.id) };
  return res;
}

export async function loadFromRepo(p) {
  const dir = repoDir(p);
  if (!dir) { notify('Set the project\'s code folder first (Project settings)', 'error'); return null; }
  const res = await window.electronAPI.repoRead({ dir });
  if (!res.ok) { notify(res.error, 'error'); return null; }
  if (res.errors.length) notify(`Skipped ${res.errors.length} unreadable file(s): ${res.errors[0]}`, 'error', 8000);
  const stats = fromRepo(p, res);
  lastWritten.set(p.id, JSON.stringify(toRepo(p)));
  return stats;
}

// Called after every DB save: projects with auto-sync on get their files rewritten (only when the
// content changed), debounced.
let autoTimer = null;
export function scheduleAutoSync() {
  if (!DB.projects.some((p) => p.repo?.auto && p.codeFolder)) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => { for (const p of DB.projects) if (p.repo?.auto && p.codeFolder) saveToRepo(p, { quietIfSame: true }); }, 1200);
}

// Watches the folders of auto-sync projects; a change from outside offers a reload.
const watching = new Set();
export function updateWatches(onExternalChange) {
  const want = new Set(DB.projects.filter((p) => p.repo?.auto && p.codeFolder).map(repoDir));
  for (const dir of want) if (!watching.has(dir)) { watching.add(dir); window.electronAPI.repoWatch(dir, true); }
  for (const dir of watching) if (!want.has(dir)) { watching.delete(dir); window.electronAPI.repoWatch(dir, false); }
  wireWatch(onExternalChange);
}
let watchWired = false;
function wireWatch(onExternalChange) {
  if (watchWired) return;
  watchWired = true;
  window.electronAPI.onRepoChanged((dir) => {
    const p = DB.projects.find((x) => repoDir(x) === dir); if (!p) return;
    notify(`Request files changed in ${p.repo?.dir || DEFAULT_DIR} (${p.name})`, 'info', 10000, { label: 'Reload', run: () => onExternalChange(p) });
  });
}

