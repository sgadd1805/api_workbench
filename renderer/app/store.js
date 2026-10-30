// Persistent data (DB) and UI state (S), plus every function that changes the DB's shape.
//
// DB shape:
//   { settings: { sidebarWidth, sidebarMode: 'projects' | 'current' | 'history', openTabs: [requestId], activeTab: requestId | null,
//                 theme: 'dark' | 'light' | 'system', zoom, layout: LAYOUT_DEFAULTS (split, side panel, session toolbar),
//                 ai: AI assistance on, aiPrompt: AI_PROMPT_DEFAULTS (what Claude prompts include; main/claude.js) },
//     projects: [Project],
//     features: [Feature],
//     notes: [Note],
//     tokenSources: [TokenSource] (tokens.js; global, not part of collection exports) }
// Note: { id, title, body (Markdown), tags: [string] (lower case, no '#'), projectId | null (null = not tied to a project), createdAt, updatedAt }
// Feature: { id, name, notes, branch, done, collapsed, createdAt, requestIds: [requestId] }
//          (the sidebar's Current view: requests being worked on, grouped by feature, across projects)
// Project: { id, name, auth, cookies: 'a=1; b=2', activeEnv: envId | null,
//            envs: [{ id, name, vars: [Row], loginUrls: [Row] (k = label, v = URL; the Session toolbar's Login picker),
//                     network: NETWORK_DEFAULTS (TLS / client certificate / proxy / HTTP/2; see main/network.js) }], folders: [{ id, name, auth, requests }], requests: [Request],
//            specs: [{ id, title, version, specVersion, operationCount, source: { type: 'file' | 'url', location }, importedAt }],
//            codeFolder: the project's source checkout (git history, terminal working folder) | '',
//            tasks: [Task], logSources: [LogSource] (tasks.js), correlation: stamp X-Request-Id / traceparent on sends,
//            traceUrl: link template for a trace viewer, e.g. http://localhost:16686/trace/{traceId} }
//            (spec documents themselves are stored by main/specs.js; see openapi/registry.js)
// Request: { id, name, method, url, headers: [Row],
//            captured?: { status, statusText, body, truncated?, at } (what the login window got, for "vs captured"; capture.js),
//            body: { type: 'none' | 'raw' | 'json' | 'form', text, form: [Row] },
//            auth: { type: 'inherit' | 'none' | 'bearer' | 'basic' | 'token', token?, user?, pass?, sourceId? (tokens.js) },
//            assertions: [string],
//            chain: [Row]  (k = response path, v = target: 'bearer' or a variable name),
//            options: { timeoutSec, followRedirects },
//            spec: { specId, opKey: 'GET /pets/{id}' } | null  (operation to validate against; null = match by URL),
//            scripts: { pre, post } (JavaScript; see scripts.js — projects have the same field, run first),
//            snapshot?: { status, body, savedAt, ignore: [rule] } (the expected response; snapshot.js) }
// Row: { k, v, on }

import { recordVar } from './varlog.js';

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const NEW_REQUEST_NAME = 'New request';
export const DEFAULT_OPTIONS = { timeoutSec: 60, followRedirects: true };
// split: 'row' (request | response) or 'column' (request above response); ratio: the request panel's share.
export const NETWORK_DEFAULTS = { caFile: '', insecure: false, certFile: '', keyFile: '', pfxFile: '', passphrase: '', proxy: '', http2: false };
export const LAYOUT_DEFAULTS = { split: 'row', ratio: 0.45, sideOpen: false, sideTab: 'spec', sideWidth: 400, session: false };
// Sections of the "Why did this fail?" / "Investigate" prompts (false leaves one out), and extra instructions for Claude.
export const AI_PROMPT_DEFAULTS = {
  request: true, requestBody: true, response: true, responseBody: true, spec: true, warnings: true, timing: true,
  logs: true, lastGood: true, commits: true, commitAuthors: true, page: true, console: true, network: true, networkBodies: true,
  instructions: '',
};

export const DB = { projects: [], features: [], notes: [], tokenSources: [], settings: { sidebarWidth: 240, openTabs: [], activeTab: null } };

export const S = {
  page: 'request', // 'request' | 'compare' | 'envs' | 'accounts' | 'history' | 'specs' | 'settings' | 'tokens' | 'tasks' | 'runner' | 'load' | 'proxy' | 'actuator'
  projectId: null, folderOpen: {}, projectOpen: {},
  req: null,       // the active tab's request
  tabs: [],        // open request tabs, in tab-bar order: [Tab] (see newTab)
  compare: { mode: 'requests', slots: [null, null], results: [null, null], resTab: 'body', ab: { reqId: null, envA: null, envB: null, results: [null, null] } },
  sidebarMode: 'projects', // 'projects' | 'current' | 'history'
  currentShowDone: false,  // Current view: the Done group is expanded
  notes: { id: null, preview: false, scope: 'project', filter: '', tag: '', popped: false }, // popped: shown in its own window (actions/notes.js)
  tokens: { id: null, test: null },
  tasks: { id: null, filter: '', level: 'all', follow: true, editing: false, view: 'live',
    search: { pattern: '', regex: false, ignoreCase: true, context: 2, since: '1h', max: 200, scope: 'source', running: false, results: [] } },
  load: { reqId: null, total: 100, concurrency: 10, durationSec: 0, running: false, runId: null, done: 0, target: null, stats: null },
  actuator: { base: '', projectId: null, tab: 'health', data: {}, loading: false, error: '', filter: '', showInternal: false, onlyConfigured: true, changed: {}, picked: new Set() }, // Actuator page
  proxy: { mocks: {}, running: false, port: 8899, lan: [], decryptHttps: false, allowLan: false, insecureUpstream: false, toHistory: true, breakpoints: '', filter: '', exchanges: [], selected: null, paused: [], ca: null }, // Proxy page (actions/proxy.js)
  specTools: { drift: null, diff: null, mock: {}, mockOpen: null }, // Specs page extras (actions/spectools.js)
  respView: { mode: 'pretty', filter: '', search: '', wrap: true, full: false }, // response body viewer options (views/viewer.js)
  runner: { scopeKey: '', envId: null, iterations: 1, delayMs: 0, stopOnFailure: false, rows: null, dataName: '', running: false, stop: false, results: [], label: '' }, // Tasks page: selected task / log source and log view // Token sources page: source being edited, last Test result // Notes side tab: open note, Markdown preview, list scope
  history: { id: null, filter: '', resTab: 'body' }, // History panel: entry open on the 'history' page, search text
  search: { open: false, query: '', results: [], selected: 0 }, // API search palette (search.js)
  envId: null,          // environment open on the envs page
  accounts: null,       // accounts page draft (loaded from main)
  modal: null,
  menu: null, // open dropdown/context menu: { items, x, y } (views/menu.js)
};

// ---- persistence
export async function loadDB() {
  const stored = await window.electronAPI.storageGet();
  const db = stored && (stored.db || stored);
  if (db && Array.isArray(db.projects)) Object.assign(DB, db);
  normalizeDB(DB);
  return { secretsUnreadable: stored?.secretsUnreadable || 0 };
}

let saveTimer = null;
export function saveDB() { clearTimeout(saveTimer); saveTimer = setTimeout(flushDB, 250); }
export function flushDB() { clearTimeout(saveTimer); saveTimer = null; window.electronAPI.storageSet({ db: DB }); for (const fn of afterSave) fn(); }
const afterSave = [];
export const onAfterSave = (fn) => afterSave.push(fn); // e.g. repo auto-sync (repo.js)
export const hasPendingSave = () => saveTimer !== null;

// Fill in fields older/imported data may lack, so lookups and renders don't throw.
export function normalizeDB(db) {
  db.settings ||= {};
  db.settings.layout = { ...LAYOUT_DEFAULTS, ...db.settings.layout };
  db.settings.aiPrompt = { ...AI_PROMPT_DEFAULTS, ...db.settings.aiPrompt };
  db.settings.theme ||= 'dark';
  db.settings.zoom ||= 1;
  db.projects.forEach(normalizeProject);
  db.features ||= [];
  for (const f of db.features) { f.requestIds ||= []; f.notes ??= ''; f.branch ??= ''; f.done ??= false; f.collapsed ??= false; }
  db.notes ||= [];
  db.tokenSources ||= [];
  for (const t of db.tokenSources) {
    t.method ||= 'POST'; t.url ??= ''; t.headers ||= []; t.body ||= { type: 'raw', text: '' }; t.body.form ||= []; t.tokenPath ||= 'access_token';
  }
  for (const n of db.notes) { n.title ??= ''; n.body ??= ''; n.tags ||= []; n.projectId ??= null; n.updatedAt ??= n.createdAt ?? Date.now(); }
  if (db === DB) pruneFeatures();
  return db;
}
export function normalizeProject(p) {
  p.folders ||= []; p.requests ||= []; p.envs ||= []; p.activeEnv ??= null; p.cookies ??= ''; p.specs ||= []; p.codeFolder ??= ''; p.tasks ||= []; p.logSources ||= []; p.correlation ??= true; p.traceUrl ??= ''; p.scripts = { pre: '', post: '', ...p.scripts };
  for (const t of p.tasks) { t.env ||= []; t.waitForReady ??= true; }
  p.auth ||= { type: 'none' };
  for (const f of p.folders) { f.requests ||= []; f.auth ||= { type: 'inherit' }; }
  for (const e of p.envs) { e.vars ||= []; e.loginUrls ||= []; e.network = { ...NETWORK_DEFAULTS, ...e.network }; }
  for (const r of allRequests(p)) normalizeRequest(r);
  return p;
}
export function normalizeRequest(r) {
  r.method ||= 'GET'; r.url ??= ''; r.headers ||= []; r.assertions ||= [];
  r.body ||= { type: 'none', text: '' }; r.body.text ??= ''; r.body.form ||= [];
  r.auth ||= { type: 'inherit' };
  r.spec ??= null;
  r.scripts = { pre: '', post: '', ...r.scripts };
  r.options = { ...DEFAULT_OPTIONS, ...r.options };
  // Older chain rules were { path } / { from: 'body.x' }, always targeting the bearer token.
  r.chain = (r.chain || []).map((c) => ('k' in c ? c : { k: String(c.path ?? c.from ?? '').replace(/^body\./, ''), v: 'bearer', on: true }));
  return r;
}

// Request kinds besides plain HTTP (renderer/app/protocols.js). r.kind is absent for HTTP.
export const kindOf = (r) => r?.kind || 'http';
const KIND_LABEL = { ws: 'WS', sse: 'SSE', graphql: 'GQL', grpc: 'gRPC' };
export const methodLabel = (r) => KIND_LABEL[kindOf(r)] || r.method;

// ---- lookups
export const project = (id) => DB.projects.find((p) => p.id === id);
export const currentProject = () => project(S.projectId);
export const folder = (p, id) => p?.folders.find((f) => f.id === id);
export const allRequests = (p) => [...p.requests, ...p.folders.flatMap((f) => f.requests)];

// A request's location: { p: project, f: folder | null, r: request }.
export function findReq(id) {
  for (const p of DB.projects) {
    for (const r of p.requests) if (r.id === id) return { p, f: null, r };
    for (const f of p.folders) for (const r of f.requests) if (r.id === id) return { p, f, r };
  }
  return null;
}

// Request auth falls back to its folder's, then its project's.
export function effectiveAuth(loc) {
  return [loc.r.auth, loc.f?.auth, loc.p.auth].find((a) => a && a.type && a.type !== 'inherit') || { type: 'none' };
}

// ---- projects, folders
export function addProject(name) {
  const p = normalizeProject({ id: uid(), name, auth: { type: 'none' } });
  DB.projects.push(p);
  return p;
}

export function addFolder(p, name) {
  const f = { id: uid(), name, auth: { type: 'inherit' }, requests: [] };
  p.folders.push(f);
  return f;
}

// Deleting can remove open requests: close their tabs and, if the active one went, activate a neighbour.
function dropMissingSelection() {
  const activeIdx = S.tabs.findIndex((t) => t.id === S.req?.id);
  S.tabs = S.tabs.filter((t) => findReq(t.id));
  if (S.req && !findReq(S.req.id)) {
    const next = S.tabs[Math.min(Math.max(activeIdx, 0), S.tabs.length - 1)];
    S.req = next ? findReq(next.id).r : null;
  }
  pruneFeatures();
  rememberTabs();
}

export function deleteProject(id) { DB.projects = DB.projects.filter((p) => p.id !== id); dropMissingSelection(); }
export function deleteFolder(p, id) { p.folders = p.folders.filter((f) => f.id !== id); dropMissingSelection(); }

// The project dialog edits auth as one "token" field: a bearer token, or "user:pass" for basic.
export function projectAuthFromForm(type, token, sourceId = '') {
  if (type === 'bearer') return { type: 'bearer', token };
  if (type === 'token') return { type: 'token', sourceId };
  if (type === 'basic') { const [user, ...pass] = token.split(':'); return { type: 'basic', user, pass: pass.join(':') }; }
  return { type: 'none' };
}
export function projectAuthToForm(auth) {
  return auth?.token || (auth?.user ? auth.user + ':' + auth.pass : '');
}

// ---- requests
export function newReq(fields) {
  return normalizeRequest({ id: uid(), name: NEW_REQUEST_NAME, ...fields });
}

// Adds to the folder when given, else to the project root.
export function addRequest(p, f, req = newReq()) {
  (f || p).requests.push(req);
  return req;
}

const containerOf = (loc) => loc.f || loc.p;

export function deleteRequest(id) {
  const loc = findReq(id); if (!loc) return;
  const list = containerOf(loc).requests;
  list.splice(list.indexOf(loc.r), 1);
  dropMissingSelection();
}

// Copy placed right after the original.
export function duplicateRequest(id) {
  const loc = findReq(id); if (!loc) return null;
  const copy = { ...structuredClone(loc.r), id: uid(), name: loc.r.name + ' copy' };
  const list = containerOf(loc).requests;
  list.splice(list.indexOf(loc.r) + 1, 0, copy);
  return copy;
}

// folderId '' = project root.
export function moveRequest(id, folderId) {
  const loc = findReq(id); if (!loc) return;
  const target = folderId ? folder(loc.p, folderId) : loc.p;
  if (!target || target === containerOf(loc)) return;
  const list = containerOf(loc).requests;
  list.splice(list.indexOf(loc.r), 1);
  target.requests.push(loc.r);
}

// Moves a request into a project's root or one of its folders (any project), before another request
// of that list or at its end. → true if it moved.
export function placeRequest(id, { projectId, folderId = null, beforeId = null }) {
  const loc = findReq(id), p = project(projectId);
  const target = p && (folderId ? folder(p, folderId) : p);
  if (!loc || !target || beforeId === id) return false;
  const from = containerOf(loc).requests;
  from.splice(from.indexOf(loc.r), 1);
  const at = beforeId ? target.requests.findIndex((r) => r.id === beforeId) : -1;
  target.requests.splice(at < 0 ? target.requests.length : at, 0, loc.r);
  return true;
}

// An auto-generated name ('New request' or a prefix of the URL) keeps following the URL.
export function setRequestUrl(r, url) {
  const auto = r.name === NEW_REQUEST_NAME || (r.name && r.url.startsWith(r.name));
  r.url = url;
  if (auto) r.name = url.slice(0, 60) || NEW_REQUEST_NAME;
}

// ---- environments
export const activeEnv = (p) => p?.envs?.find((e) => e.id === p.activeEnv) || null;

export function addEnv(p, name) {
  const env = { id: uid(), name, vars: [], loginUrls: [], network: { ...NETWORK_DEFAULTS } };
  p.envs.push(env);
  if (!p.activeEnv) p.activeEnv = env.id;
  return env;
}

export function deleteEnv(p, id) {
  p.envs = p.envs.filter((e) => e.id !== id);
  if (p.activeEnv === id) p.activeEnv = p.envs[0]?.id ?? null;
}

// Sets a variable in the active environment, creating a "Default" one when there is none.
// source / kind: what set it, for the variable history (varlog.js).
export function setVar(p, name, value, { source = '', kind = 'other' } = {}) {
  const env = activeEnv(p) || addEnv(p, 'Default');
  p.activeEnv = env.id;
  const row = env.vars.find((v) => v.k === name);
  recordVar({ p, env, name, before: row?.v, value, secret: !!row?.secret, source, kind });
  if (row) { row.v = value; row.on = true; } else env.vars.push({ k: name, v: value, on: true });
}

// ---- request tabs
// Each open request keeps its own UI state, so a request can be sending in one tab while you work in another.
// Tab: { id: request id,
//        editorTab: 'params' | 'headers' | … (views/request.js REQUEST_TABS), resTab: 'body' | 'headers' | 'history',
//        response, sending: in-flight send id (for Cancel) | null, unseen: a response arrived while in the background,
//        historyBase: which earlier run the History tab diffs against (index into history.js runsFor()),
//        pendingParam: Params shows an extra empty row until something is typed in it }
export const newTab = (id) => ({ id, editorTab: 'params', resTab: 'body', response: null, sending: null, unseen: false, historyBase: 1, pendingParam: false });
export const tabFor = (reqId) => S.tabs.find((t) => t.id === reqId) || null;
export const activeTab = () => (S.req ? tabFor(S.req.id) : null);

// Opens (or finds) the request's tab and makes it active. New tabs go right after the active one.
export function activateTab(reqId) {
  const loc = findReq(reqId); if (!loc) return null;
  let tab = tabFor(reqId);
  if (!tab) {
    tab = newTab(reqId);
    const at = S.tabs.indexOf(activeTab());
    S.tabs.splice(at < 0 ? S.tabs.length : at + 1, 0, tab);
  }
  tab.unseen = false;
  S.req = loc.r; S.projectId = loc.p.id;
  rememberTabs();
  return tab;
}

// Closes a tab; when it was active, the tab to its right (else left) becomes active. → the closed tab
export function closeTab(reqId) {
  const i = S.tabs.findIndex((t) => t.id === reqId); if (i < 0) return null;
  const [tab] = S.tabs.splice(i, 1);
  if (S.req?.id === reqId) {
    const next = S.tabs[Math.min(i, S.tabs.length - 1)];
    if (next) activateTab(next.id); else S.req = null;
  }
  rememberTabs();
  return tab;
}

export function moveTab(reqId, toIndex) {
  const i = S.tabs.findIndex((t) => t.id === reqId); if (i < 0) return;
  const [tab] = S.tabs.splice(i, 1);
  S.tabs.splice(Math.max(0, Math.min(toIndex, S.tabs.length)), 0, tab);
  rememberTabs();
}

// Open tabs survive restarts (their responses don't).
function rememberTabs() {
  DB.settings.openTabs = S.tabs.map((t) => t.id);
  DB.settings.activeTab = S.req?.id ?? null;
  saveDB();
}
export function restoreTabs() {
  S.tabs = (DB.settings.openTabs || []).filter((id) => findReq(id)).map(newTab);
  const active = tabFor(DB.settings.activeTab) || S.tabs[0];
  if (active) activateTab(active.id);
}

// ---- feature groups (sidebar → Current)
export const feature = (id) => DB.features.find((f) => f.id === id) || null;
export const openFeatures = () => DB.features.filter((f) => !f.done);
export const featuresWith = (reqId) => DB.features.filter((f) => f.requestIds.includes(reqId));

export function addFeature(name) {
  const f = { id: uid(), name, notes: '', branch: '', done: false, collapsed: false, createdAt: Date.now(), requestIds: [] };
  DB.features.unshift(f); // newest on top
  return f;
}

export function deleteFeature(id) { DB.features = DB.features.filter((f) => f.id !== id); }

// No duplicates; → true if it was added.
export function addToFeature(featureId, reqId) {
  const f = feature(featureId);
  if (!f || !findReq(reqId) || f.requestIds.includes(reqId)) return false;
  f.requestIds.push(reqId);
  return true;
}

export function removeFromFeature(featureId, reqId) {
  const f = feature(featureId);
  if (f) f.requestIds = f.requestIds.filter((id) => id !== reqId);
}

// Drop references to requests that no longer exist (deleted requests, folders or projects).
export function pruneFeatures() {
  for (const f of DB.features) f.requestIds = f.requestIds.filter((id) => findReq(id));
}

// ---- notes (side panel → Notes)
export const note = (id) => DB.notes.find((n) => n.id === id) || null;

export function addNote(projectId = null) {
  const n = { id: uid(), title: '', body: '', tags: [], projectId, createdAt: Date.now(), updatedAt: Date.now() };
  DB.notes.unshift(n);
  return n;
}

export function updateNote(id, fields) {
  const n = note(id); if (!n) return;
  Object.assign(n, fields, { updatedAt: Date.now() });
  // Most recently edited first.
  DB.notes = [n, ...DB.notes.filter((x) => x !== n)];
}

export function deleteNote(id) { DB.notes = DB.notes.filter((n) => n.id !== id); }

// Notes for the current project (plus unassigned ones), or all of them.
export function visibleNotes(scope, projectId) {
  return scope === 'all' ? DB.notes : DB.notes.filter((n) => !n.projectId || n.projectId === projectId);
}

