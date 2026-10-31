// api-client.json: a hand-written (or AI-written) description of a project's API setup, kept in the
// code repo and applied by the app, so nobody edits the app's own data files. The format is documented
// in docs/CONFIGURING.md and docs/api-client.schema.json.
// Applying merges: things are matched by name (environments, folders, requests within a folder,
// features, tasks, log sources, token sources, notes by title, test accounts by label) and what the file
// says wins; nothing missing from the file is deleted. exportConfig goes the other way: a project's
// current setup as an api-client.json, without secret values.
import { DB, uid, newReq, addProject, addEnv, addFolder, addRequest, addFeature, addToFeature, allRequests, NETWORK_DEFAULTS, LAYOUT_DEFAULTS, AI_PROMPT_DEFAULTS, DEFAULT_OPTIONS } from './store.js';
import { newTask, newLogSource, sourceParts } from './tasks.js';
import { newTokenSource } from './tokens.js';
import { withQuery } from './query.js';
import { setKind } from './protocols.js';
import { joinPath as join, relPath as rel } from '../shared/paths.js';
import { safeRepoSubdir } from './repo.js';

export const CONFIG_FILE = 'api-client.json';
const LOG_WATCH_DEFAULTS = { levels: true, patterns: '', notify: true };
// App settings a project file may set. AI assistance (sends data to Anthropic) and letting other devices
// use the proxy (opens a port to the network) stay switches only the user flips in the app.
const PROXY_KEYS = ['port', 'decryptHttps', 'insecureUpstream', 'toHistory', 'breakpoints'];
const OTEL_KEYS = ['autoStart', 'httpPort', 'grpcPort'];
const LAYOUT_KEYS = ['split', 'sideOpen', 'session'];
const LOG_TYPES = { kubernetes: 'k8s', ssh: 'ssh', docker: 'docker' }; // file key → LogSource field

// { name: value | { value, enabled: false } } → [Row]
const rows = (obj) => Object.entries(obj || {}).map(([k, v]) => (v && typeof v === 'object'
  ? { k, v: String(v.value ?? ''), on: v.enabled !== false }
  : { k, v: String(v), on: true }));
const pick = (src, keys) => Object.fromEntries(keys.filter((k) => src?.[k] !== undefined).map((k) => [k, src[k]]));
const jsonText = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function authFrom(a) {
  if (!a) return undefined;
  if (typeof a === 'string') return { type: a };
  if (a.type === 'token' && a.source) {
    const src = DB.tokenSources.find((t) => t.name === a.source || t.id === a.source);
    return { type: 'token', sourceId: src?.id || '' };
  }
  return { ...a };
}

function bodyFrom(c) {
  if (c.json !== undefined) return { type: 'json', text: jsonText(c.json), form: [] };
  if (typeof c.body === 'string') return { type: 'raw', text: c.body, form: [] };
  if (c.body?.type === 'form') return { type: 'form', text: '', form: rows(c.body.fields) };
  if (c.body?.type) return { type: c.body.type, text: c.body.text || '', form: rows(c.body.fields) };
  return undefined;
}

// Applies one request entry onto r (new or existing). A spec `operation` is linked later (linkOperations),
// once the project's specs are loaded.
function applyRequest(r, c, codeFolder, warnings) {
  if (c.kind) setKind(r, c.kind);
  if (c.method) r.method = String(c.method).toUpperCase();
  if (c.url !== undefined) r.url = c.query ? withQuery(c.url, Object.entries(c.query).map(([k, v]) => ({ k, v: String(v) }))) : c.url;
  if (c.headers) r.headers = rows(c.headers);
  const body = bodyFrom(c); if (body) r.body = body;
  const auth = authFrom(c.auth); if (auth) r.auth = auth;
  if (auth?.type === 'token' && !auth.sourceId) warnings.push(`Request "${c.name}": no token source "${c.auth.source}"`);
  if (c.assertions) r.assertions = [...c.assertions];
  if (c.extract) r.chain = rows(c.extract);
  if (c.scripts) r.scripts = { pre: c.scripts.pre || '', post: c.scripts.post || '' };
  if (c.timeoutSec !== undefined || c.followRedirects !== undefined) r.options = { ...r.options, ...(c.timeoutSec !== undefined && { timeoutSec: c.timeoutSec }), ...(c.followRedirects !== undefined && { followRedirects: c.followRedirects }) };
  if (c.graphql) r.graphql = { query: c.graphql.query || '', variables: typeof c.graphql.variables === 'string' ? c.graphql.variables : c.graphql.variables ? JSON.stringify(c.graphql.variables, null, 2) : '' };
  if (c.ws) r.ws = { message: typeof c.ws.message === 'string' ? c.ws.message : JSON.stringify(c.ws.message ?? '', null, 2) };
  if (c.grpc) {
    r.grpc = { protoFile: c.grpc.proto ? join(codeFolder, c.grpc.proto) : r.grpc?.protoFile || '', includeDirs: (c.grpc.includeDirs || []).map((d) => join(codeFolder, d)).join(', '), service: c.grpc.service || '', method: c.grpc.method || '' };
    if (c.grpc.message !== undefined) r.body = { type: 'json', text: jsonText(c.grpc.message), form: [] };
  }
  if (c.snapshot) {
    const s = c.snapshot, ignore = s.ignore ? [...s.ignore] : r.snapshot?.ignore || [];
    const expected = s.json !== undefined ? jsonText(s.json) : s.body;
    if (expected !== undefined) r.snapshot = { status: s.status ?? r.snapshot?.status ?? 200, body: expected, savedAt: Date.now(), ignore };
    else if (r.snapshot) r.snapshot.ignore = ignore;
    else warnings.push(`Request "${c.name}": snapshot.ignore needs an expected body (snapshot.json or snapshot.body), or a snapshot saved in the app`);
  }
}

function applyTokenSource(c, count) {
  let t = DB.tokenSources.find((x) => x.name === c.name);
  if (!t) { t = newTokenSource({ name: c.name }); DB.tokenSources.push(t); count('token sources'); }
  if (c.method) t.method = String(c.method).toUpperCase();
  if (c.url !== undefined) t.url = c.url;
  if (c.headers) t.headers = rows(c.headers);
  const body = bodyFrom(c); if (body) t.body = body;
  if (c.tokenPath) t.tokenPath = c.tokenPath;
}

function applySettings(c) {
  const s = DB.settings;
  if (c.theme) s.theme = c.theme;
  if (c.zoom !== undefined) s.zoom = c.zoom;
  if (c.editorWrap !== undefined) s.editorWrap = !!c.editorWrap;
  if (c.layout) s.layout = { ...LAYOUT_DEFAULTS, ...s.layout, ...pick(c.layout, LAYOUT_KEYS) };
  if (c.otel) s.otel = { autoStart: false, httpPort: 4318, grpcPort: 4317, ...s.otel, ...pick(c.otel, OTEL_KEYS) };
  if (c.proxy) s.proxy = { ...s.proxy, ...pick(c.proxy, PROXY_KEYS), ...(Array.isArray(c.proxy.breakpoints) && { breakpoints: c.proxy.breakpoints.join('\n') }) };
  if (c.aiPrompt) s.aiPrompt = { ...AI_PROMPT_DEFAULTS, ...s.aiPrompt, ...pick(c.aiPrompt, Object.keys(AI_PROMPT_DEFAULTS)) };
}

// → { project, created: bool, summary: { [what]: n }, specs: [locations to attach],
//     links: [{ id: requestId, operation }] (linkOperations), accounts: [{ label, user, env }] (saved by the
//     caller: they live in the main process), settings: bool (app settings changed), warnings: [] }
// codeFolder: the file's folder, for relative paths; adoptCodeFolder: make it the project's code folder if it has none.
export function applyConfig(cfg, { project: target = null, codeFolder = '', adoptCodeFolder = true } = {}) {
  const warnings = [], summary = {}, links = [];
  const count = (k) => { summary[k] = (summary[k] || 0) + 1; };
  if (!cfg || typeof cfg !== 'object') throw new Error('api-client.json must contain a JSON object');
  if (cfg.version !== undefined && cfg.version !== 1) warnings.push(`Unknown version ${cfg.version}; applied as version 1`);
  const pc = cfg.project || {};
  let p = target || (pc.name && DB.projects.find((x) => x.name === pc.name)) || null;
  const created = !p;
  if (!p) { p = addProject(pc.name || 'New project'); count('project'); }
  if (adoptCodeFolder && codeFolder && !p.codeFolder) p.codeFolder = codeFolder;
  const base = adoptCodeFolder ? p.codeFolder || codeFolder : codeFolder || p.codeFolder;

  // Token sources first: requests, folders and the project refer to them by name.
  for (const tc of cfg.tokenSources || []) { if (tc.name) applyTokenSource(tc, count); else warnings.push('A token source without a name was skipped'); }

  const auth = authFrom(pc.auth); if (auth) p.auth = auth;
  if (pc.correlation !== undefined) p.correlation = !!pc.correlation;
  if (pc.traceUrl !== undefined) p.traceUrl = pc.traceUrl;
  if (pc.cookies !== undefined) p.cookies = pc.cookies;
  if (pc.scripts) p.scripts = { pre: pc.scripts.pre || '', post: pc.scripts.post || '' };
  const repoDirOk = pc.repoDir === undefined || pc.repoDir === '' || safeRepoSubdir(pc.repoDir);
  if (!repoDirOk) warnings.push(`project.repoDir "${pc.repoDir}" was ignored: it must be a folder inside the code folder (no absolute path, no "..")`);
  if ((pc.repoDir !== undefined && repoDirOk) || pc.repoSync !== undefined) p.repo = { ...(p.repo || {}), ...(pc.repoDir !== undefined && repoDirOk && { dir: pc.repoDir }), ...(pc.repoSync !== undefined && { auto: !!pc.repoSync }) };
  if (pc.actuatorBase !== undefined) p.actuatorBase = pc.actuatorBase;
  if (pc.logWatch) {
    const w = pc.logWatch;
    p.logWatch = { ...LOG_WATCH_DEFAULTS, ...p.logWatch, ...pick(w, ['levels', 'notify']), ...(w.patterns !== undefined && { patterns: Array.isArray(w.patterns) ? w.patterns.join(', ') : w.patterns }) };
  }

  for (const e of cfg.environments || []) {
    if (!e.name) { warnings.push('An environment without a name was skipped'); continue; }
    let env = p.envs.find((x) => x.name === e.name);
    if (!env) { env = addEnv(p, e.name); count('environments'); }
    for (const [k, v] of Object.entries(e.variables || {})) {
      const secret = v && typeof v === 'object' && v.secret;
      const value = secret ? null : v && typeof v === 'object' ? String(v.value ?? '') : String(v);
      const on = !(v && typeof v === 'object' && v.enabled === false);
      const row = env.vars.find((x) => x.k === k);
      if (row) { if (value !== null) row.v = value; row.on = on; if (secret) row.secret = true; }
      else { env.vars.push({ k, v: value ?? '', on, ...(secret && { secret: true }) }); count('variables'); }
    }
    for (const [label, url] of Object.entries(e.loginUrls || {})) {
      env.loginUrls ||= [];
      const row = env.loginUrls.find((x) => x.k === label);
      if (row) row.v = url; else env.loginUrls.push({ k: label, v: url, on: true });
    }
    if (e.network) {
      const { passphrase: _never, ...net } = e.network; // a certificate passphrase is entered in the app
      env.network = { ...NETWORK_DEFAULTS, ...env.network, ...net, ...['caFile', 'certFile', 'keyFile', 'pfxFile'].reduce((o, k) => (net[k] ? { ...o, [k]: join(base, net[k]) } : o), {}) };
    }
    if (e.active) p.activeEnv = env.id;
  }
  if (!p.activeEnv && p.envs.length) p.activeEnv = p.envs[0].id;

  const byPath = new Map(); // "Folder/Name" and "Name" → request id (for features)
  const putRequests = (list, f) => {
    for (const c of list || []) {
      if (!c.name) { warnings.push('A request without a name was skipped'); continue; }
      const container = f || p;
      let r = container.requests.find((x) => x.name === c.name);
      if (!r) { r = addRequest(p, f, newReq({ name: c.name })); count('requests'); } else count('requests updated');
      applyRequest(r, c, base, warnings);
      if (c.operation) links.push({ id: r.id, operation: c.operation });
      byPath.set(f ? `${f.name}/${c.name}` : c.name, r.id);
      if (!byPath.has(c.name)) byPath.set(c.name, r.id);
    }
  };
  for (const fc of cfg.folders || []) {
    if (!fc.name) { warnings.push('A folder without a name was skipped'); continue; }
    let f = p.folders.find((x) => x.name === fc.name);
    if (!f) { f = addFolder(p, fc.name); count('folders'); }
    const fa = authFrom(fc.auth); if (fa) f.auth = fa;
    putRequests(fc.requests, f);
  }
  putRequests(cfg.requests, null);
  // Requests already in the project can be referenced by features too.
  for (const r of p.requests) if (!byPath.has(r.name)) byPath.set(r.name, r.id);
  for (const f of p.folders) for (const r of f.requests) { if (!byPath.has(`${f.name}/${r.name}`)) byPath.set(`${f.name}/${r.name}`, r.id); if (!byPath.has(r.name)) byPath.set(r.name, r.id); }

  for (const fc of cfg.features || []) {
    if (!fc.name) continue;
    let feat = DB.features.find((x) => x.name === fc.name);
    if (!feat) { feat = addFeature(fc.name); count('features'); }
    if (fc.notes !== undefined) feat.notes = fc.notes;
    if (fc.branch !== undefined) feat.branch = fc.branch;
    if (fc.done !== undefined) feat.done = !!fc.done;
    for (const ref of fc.requests || []) {
      const id = byPath.get(ref);
      if (id) addToFeature(feat.id, id); else warnings.push(`Feature "${fc.name}": no request "${ref}"`);
    }
  }

  for (const tc of cfg.tasks || []) {
    if (!tc.name) continue;
    let t = p.tasks.find((x) => x.name === tc.name);
    if (!t) { t = newTask({ name: tc.name }); p.tasks.push(t); count('tasks'); }
    for (const k of ['command', 'cwd', 'javaHome', 'profile', 'jvmOpts', 'readyLog', 'readyUrl']) if (tc[k] !== undefined) t[k] = tc[k];
    if (tc.waitForReady !== undefined) t.waitForReady = !!tc.waitForReady;
    if (tc.env) t.env = rows(tc.env);
  }
  for (const lc of cfg.logSources || []) {
    if (!lc.name) continue;
    let s = p.logSources.find((x) => x.name === lc.name);
    if (!s) { s = newLogSource({ name: lc.name, type: lc.type || 'file' }); p.logSources.push(s); count('log sources'); }
    Object.assign(s, sourceParts(s));
    for (const k of ['type', 'command']) if (lc[k] !== undefined) s[k] = lc[k];
    if (lc.path !== undefined) s.path = join(base, lc.path);
    for (const [key, field] of Object.entries(LOG_TYPES)) if (lc[key]) s[field] = { ...s[field], ...Object.fromEntries(Object.entries(lc[key]).map(([k, v]) => [k, String(v)])) };
    if (lc.ssh?.identityFile) s.ssh.identityFile = lc.ssh.identityFile; // ~ and absolute paths stay as written
  }

  for (const nc of cfg.notes || []) {
    if (!nc.title) { warnings.push('A note without a title was skipped'); continue; }
    const projectId = nc.global ? null : p.id;
    let n = DB.notes.find((x) => x.title === nc.title && x.projectId === projectId);
    if (!n) { n = { id: uid(), title: nc.title, body: '', tags: [], projectId, createdAt: Date.now(), updatedAt: Date.now() }; DB.notes.unshift(n); count('notes'); }
    if (nc.body !== undefined) n.body = nc.body;
    if (nc.tags) n.tags = nc.tags.map((t) => String(t).replace(/^#/, '').toLowerCase());
    n.updatedAt = Date.now();
  }

  if (cfg.settings) { applySettings(cfg.settings); count('app settings'); }
  const accounts = (cfg.accounts || []).filter((a) => a.label || a.user).map((a) => ({ label: a.label || '', user: a.user || '', env: a.env || '' }));

  const specs = (cfg.specs || []).map((s) => join(base, typeof s === 'string' ? s : s.location)).filter((loc) => !p.specs.some((x) => x.source.location === loc));
  return { project: p, created, summary, specs, links, accounts, settings: !!cfg.settings, warnings };
}

// What applying cfg would change that runs code on this computer or weakens TLS: task and log-source
// commands, scripts, certificate checks, CAs and proxies. Applying replaces these on entries matched by
// name, so the caller shows them before a file from the code folder (a git pull, a teammate's PR) is applied.
// Same options as applyConfig; nothing is changed. → [{ what, name, field, before, after }] ('' = not set)
export function riskyChanges(cfg, { project: target = null, codeFolder = '', adoptCodeFolder = true } = {}) {
  if (!cfg || typeof cfg !== 'object') return [];
  const out = [];
  const pc = cfg.project || {};
  const p = target || (pc.name && DB.projects.find((x) => x.name === pc.name)) || null;
  const pName = p?.name || pc.name || 'New project';
  const base = adoptCodeFolder ? p?.codeFolder || codeFolder : codeFolder || p?.codeFolder;
  const text = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  const diff = (what, name, field, before, after) => { if (after !== undefined && text(after) !== text(before)) out.push({ what, name, field, before: text(before), after: text(after) }); };
  const flag = (what, name, field, before, after) => { if (after !== undefined && !!after !== !!before) out.push({ what, name, field, before: String(!!before), after: String(!!after) }); };
  const scripts = (what, name, old, c) => { if (c) for (const k of ['pre', 'post']) diff(what, name, `${k}-script`, old?.[k] || '', c[k] || ''); };
  const envText = (list) => (list || []).filter((x) => x.k).map((x) => `${x.k}=${x.v}${x.on === false ? ' (off)' : ''}`).join('\n');

  scripts('Project', pName, p?.scripts, pc.scripts);
  const requests = (list, f, label) => {
    for (const c of list || []) if (c.name) scripts('Request', label ? `${label}/${c.name}` : c.name, (f || (label ? null : p))?.requests.find((x) => x.name === c.name)?.scripts, c.scripts);
  };
  for (const fc of cfg.folders || []) if (fc.name) requests(fc.requests, p?.folders.find((x) => x.name === fc.name), fc.name);
  requests(cfg.requests, null, '');

  for (const e of cfg.environments || []) {
    if (!e.name || !e.network) continue;
    const old = { ...NETWORK_DEFAULTS, ...p?.envs.find((x) => x.name === e.name)?.network };
    flag('Environment', e.name, 'ignore certificate errors', old.insecure, e.network.insecure);
    diff('Environment', e.name, 'proxy', old.proxy, e.network.proxy);
    diff('Environment', e.name, 'CA file', old.caFile, e.network.caFile && join(base, e.network.caFile));
  }
  for (const tc of cfg.tasks || []) {
    if (!tc.name) continue;
    const t = p?.tasks.find((x) => x.name === tc.name);
    for (const k of ['command', 'cwd', 'javaHome', 'jvmOpts']) diff('Task', tc.name, k, t?.[k], tc[k]);
    if (tc.env) diff('Task', tc.name, 'env', envText(t?.env), envText(rows(tc.env)));
  }
  for (const lc of cfg.logSources || []) {
    if (!lc.name) continue;
    const s = p?.logSources.find((x) => x.name === lc.name);
    for (const k of ['type', 'command']) diff('Log source', lc.name, k, s?.[k], lc[k]);
    for (const [key, field] of Object.entries(LOG_TYPES)) {
      if (lc[key]) diff('Log source', lc.name, key, s?.[field], { ...s?.[field], ...Object.fromEntries(Object.entries(lc[key]).map(([k, v]) => [k, String(v)])) });
    }
  }
  const proxy = cfg.settings?.proxy;
  if (proxy) for (const k of ['insecureUpstream', 'decryptHttps']) flag('App settings', 'proxy', k, DB.settings.proxy?.[k], proxy[k]);
  return out;
}

// Links requests to spec operations by "METHOD /path" key or operationId. analysisOf(specId) → the
// analyzed spec (openapi/registry.js specAnalysis). → warnings for operations no attached spec has.
export function linkOperations(p, links, analysisOf) {
  const warnings = [];
  for (const { id, operation } of links) {
    const r = allRequests(p).find((x) => x.id === id); if (!r) continue;
    const key = String(operation).trim().replace(/^(\w+)\s+/, (_m, verb) => verb.toUpperCase() + ' ');
    let hit = null;
    for (const meta of p.specs) {
      const a = analysisOf(meta.id); if (!a) continue;
      const op = a.byKey.get(key) || a.operations.find((o) => o.operationId === operation);
      if (op) { hit = { specId: meta.id, opKey: op.key }; break; }
    }
    if (hit) r.spec = hit; else warnings.push(`Request "${r.name}": no operation "${operation}" in the attached specs`);
  }
  return warnings;
}

// ---- Export: a project's setup as api-client.json

const objOf = (list, { keepDisabled = true } = {}) => {
  const out = {};
  for (const r of list || []) if (r.k && (r.on !== false || keepDisabled)) out[r.k] = r.on === false ? { value: r.v, enabled: false } : r.v;
  return out;
};
const parsed = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
const isVarRef = (s) => !s || /^\s*\{\{[^}]+\}\}\s*$/.test(s);

// Auth without literal secrets: a bearer token or password that isn't a {{variable}} becomes "".
function authOut(a, warnings, where) {
  if (!a || a.type === 'inherit') return undefined;
  if (a.type === 'none') return 'none';
  if (a.type === 'token') return { type: 'token', source: DB.tokenSources.find((t) => t.id === a.sourceId)?.name || '' };
  const out = { type: a.type };
  if (a.type === 'bearer') { out.token = isVarRef(a.token) ? a.token || '' : ''; if (!isVarRef(a.token)) warnings.push(`${where}: a literal bearer token was left out; use {{variable}}`); }
  if (a.type === 'basic') { out.user = a.user || ''; out.pass = isVarRef(a.pass) ? a.pass || '' : ''; if (!isVarRef(a.pass)) warnings.push(`${where}: a literal password was left out; use {{variable}}`); }
  return out;
}

function requestOut(r, base, warnings) {
  const c = { name: r.name };
  if (r.kind) c.kind = r.kind;
  if (r.method && r.method !== 'GET' && !['graphql', 'grpc', 'ws'].includes(r.kind)) c.method = r.method;
  c.url = r.url || '';
  if (r.headers?.some((h) => h.k)) c.headers = objOf(r.headers);
  if (r.kind === 'grpc') {
    c.grpc = { proto: rel(base, r.grpc?.protoFile || ''), service: r.grpc?.service || '', method: r.grpc?.method || '' };
    const dirs = String(r.grpc?.includeDirs || '').split(',').map((d) => d.trim()).filter(Boolean);
    if (dirs.length) c.grpc.includeDirs = dirs.map((d) => rel(base, d));
    if (r.body?.text) c.grpc.message = parsed(r.body.text) ?? r.body.text;
  } else if (r.body?.type === 'json' && r.body.text) c.json = parsed(r.body.text) ?? r.body.text;
  else if (r.body?.type === 'raw' && r.body.text) c.body = r.body.text;
  else if (r.body?.type === 'form' && r.body.form?.some((x) => x.k)) c.body = { type: 'form', fields: Object.fromEntries(r.body.form.filter((x) => x.k && x.on !== false).map((x) => [x.k, x.v])) };
  const auth = authOut(r.auth, warnings, `Request "${r.name}"`); if (auth) c.auth = auth;
  if (r.assertions?.length) c.assertions = [...r.assertions];
  if (r.chain?.some((x) => x.k)) c.extract = Object.fromEntries(r.chain.filter((x) => x.k && x.on !== false).map((x) => [x.k, x.v]));
  if (r.scripts?.pre || r.scripts?.post) c.scripts = { ...(r.scripts.pre && { pre: r.scripts.pre }), ...(r.scripts.post && { post: r.scripts.post }) };
  if (r.options?.timeoutSec !== undefined && r.options.timeoutSec !== DEFAULT_OPTIONS.timeoutSec) c.timeoutSec = r.options.timeoutSec;
  if (r.options?.followRedirects !== undefined && r.options.followRedirects !== DEFAULT_OPTIONS.followRedirects) c.followRedirects = r.options.followRedirects;
  if (r.kind === 'graphql' && r.graphql) c.graphql = { query: r.graphql.query || '', ...(r.graphql.variables && { variables: parsed(r.graphql.variables) ?? r.graphql.variables }) };
  if (r.kind === 'ws' && r.ws?.message) c.ws = { message: parsed(r.ws.message) ?? r.ws.message };
  if (r.spec?.opKey) c.operation = r.spec.opKey;
  if (r.snapshot) {
    const body = parsed(r.snapshot.body);
    c.snapshot = { status: r.snapshot.status, ...(body !== undefined ? { json: body } : { body: r.snapshot.body }), ...(r.snapshot.ignore?.length && { ignore: [...r.snapshot.ignore] }) };
  }
  return c;
}

// p → { config: api-client.json object, warnings }. Secret values never leave: secret variables become
// { "secret": true }, literal tokens and passwords are blanked, and the cookie jar and certificate
// passphrases are left out. accounts: the Session toolbar's test accounts (main/accounts.js public list).
// settings: include the app settings a project file may set.
export function exportConfig(p, { accounts = [], settings = false } = {}) {
  const warnings = [], base = p.codeFolder || '';
  const cfg = { version: 1 };
  const proj = { name: p.name };
  const pa = authOut(p.auth, warnings, 'Project'); if (pa && pa !== 'none') proj.auth = pa;
  if (p.correlation === false) proj.correlation = false;
  if (p.traceUrl) proj.traceUrl = p.traceUrl;
  if (p.scripts?.pre || p.scripts?.post) proj.scripts = { ...(p.scripts.pre && { pre: p.scripts.pre }), ...(p.scripts.post && { post: p.scripts.post }) };
  if (p.repo?.dir) proj.repoDir = p.repo.dir;
  if (p.repo?.auto !== undefined) proj.repoSync = !!p.repo.auto;
  if (p.actuatorBase) proj.actuatorBase = p.actuatorBase;
  if (p.logWatch) proj.logWatch = { levels: p.logWatch.levels !== false, notify: p.logWatch.notify !== false, patterns: String(p.logWatch.patterns || '').split(',').map((x) => x.trim()).filter(Boolean) };
  cfg.project = proj;

  const sourceIds = new Set();
  const noteAuth = (a) => { if (a?.type === 'token' && a.sourceId) sourceIds.add(a.sourceId); };
  noteAuth(p.auth); p.folders.forEach((f) => { noteAuth(f.auth); f.requests.forEach((r) => noteAuth(r.auth)); }); p.requests.forEach((r) => noteAuth(r.auth));
  const sources = DB.tokenSources.filter((t) => sourceIds.has(t.id));
  if (sources.length) cfg.tokenSources = sources.map((t) => {
    const s = { name: t.name, method: t.method, url: t.url, tokenPath: t.tokenPath };
    if (t.headers?.some((h) => h.k)) s.headers = objOf(t.headers);
    if (t.body?.type === 'form') s.body = { type: 'form', fields: Object.fromEntries(t.body.form.filter((x) => x.k).map((x) => [x.k, x.v])) };
    else if (t.body?.type === 'json' && t.body.text) s.json = parsed(t.body.text) ?? t.body.text;
    else if (t.body?.text) s.body = t.body.text;
    return s;
  });

  if (p.envs.length) cfg.environments = p.envs.map((e) => {
    const env = { name: e.name };
    if (e.id === p.activeEnv) env.active = true;
    const vars = {};
    for (const v of e.vars) if (v.k) vars[v.k] = v.secret ? { secret: true } : v.on === false ? { value: v.v, enabled: false } : v.v;
    env.variables = vars;
    const logins = Object.fromEntries((e.loginUrls || []).filter((x) => x.k).map((x) => [x.k, x.v]));
    if (Object.keys(logins).length) env.loginUrls = logins;
    const net = {};
    for (const [k, v] of Object.entries(e.network || {})) if (k !== 'passphrase' && v !== NETWORK_DEFAULTS[k]) net[k] = ['caFile', 'certFile', 'keyFile', 'pfxFile'].includes(k) ? rel(base, v) : v;
    if (e.network?.passphrase) warnings.push(`Environment "${e.name}": the certificate passphrase was left out`);
    if (Object.keys(net).length) env.network = net;
    return env;
  });
  if (p.folders.length) cfg.folders = p.folders.map((f) => {
    const auth = authOut(f.auth, warnings, `Folder "${f.name}"`);
    return { name: f.name, ...(auth && { auth }), requests: f.requests.map((r) => requestOut(r, base, warnings)) };
  });
  if (p.requests.length) cfg.requests = p.requests.map((r) => requestOut(r, base, warnings));

  const pathOf = new Map([...p.requests.map((r) => [r.id, r.name]), ...p.folders.flatMap((f) => f.requests.map((r) => [r.id, `${f.name}/${r.name}`]))]);
  const features = DB.features.filter((f) => f.requestIds.some((id) => pathOf.has(id)));
  if (features.length) cfg.features = features.map((f) => ({ name: f.name, ...(f.branch && { branch: f.branch }), ...(f.notes && { notes: f.notes }), ...(f.done && { done: true }), requests: f.requestIds.filter((id) => pathOf.has(id)).map((id) => pathOf.get(id)) }));
  if (p.specs.length) cfg.specs = p.specs.map((s) => rel(base, s.source.location));
  if (p.tasks.length) cfg.tasks = p.tasks.map((t) => ({ name: t.name, ...Object.fromEntries(['command', 'cwd', 'javaHome', 'profile', 'jvmOpts', 'readyLog', 'readyUrl'].filter((k) => t[k]).map((k) => [k, t[k]])), ...(t.waitForReady === false && { waitForReady: false }), ...(t.env?.some((x) => x.k) && { env: objOf(t.env, { keepDisabled: false }) }) }));
  if (p.logSources.length) cfg.logSources = p.logSources.map((s) => {
    const out = { name: s.name, type: s.type };
    if (s.type === 'file' && s.path) out.path = rel(base, s.path);
    if (s.type === 'command' && s.command) out.command = s.command;
    const field = { ssh: 'ssh', kubernetes: 'k8s', docker: 'docker' }[s.type];
    if (field) { const parts = Object.fromEntries(Object.entries(s[field] || {}).filter(([, v]) => v !== '' && v != null)); if (Object.keys(parts).length) out[s.type] = parts; }
    return out;
  });
  const notes = DB.notes.filter((n) => n.projectId === p.id && n.title);
  if (notes.length) cfg.notes = notes.map((n) => ({ title: n.title, body: n.body, ...(n.tags?.length && { tags: [...n.tags] }) }));
  if (accounts.length) cfg.accounts = accounts.map((a) => ({ label: a.label, user: a.user, ...(a.env && { env: a.env }) }));
  if (settings) {
    const s = DB.settings;
    cfg.settings = { theme: s.theme, zoom: s.zoom, editorWrap: !!s.editorWrap, layout: pick(s.layout, LAYOUT_KEYS),
      ...(s.otel && { otel: pick(s.otel, OTEL_KEYS) }), ...(s.proxy && { proxy: pick(s.proxy, PROXY_KEYS) }), aiPrompt: { ...s.aiPrompt } };
  }
  return { config: cfg, warnings };
}

// ---- Importing just the requests of an api-client.json

// cfg → ["Folder/Request" | "Request"] in file order
export function configRequestPaths(cfg) {
  return [...(cfg.folders || []).flatMap((f) => (f.requests || []).filter((r) => r.name).map((r) => `${f.name}/${r.name}`)), ...(cfg.requests || []).filter((r) => r.name).map((r) => r.name)];
}
// The part of cfg holding the chosen requests (and the token sources they use), to apply into a project.
export function requestsOnly(cfg, chosen) {
  const want = new Set(chosen);
  const folders = (cfg.folders || []).map((f) => ({ name: f.name, ...(f.auth && { auth: f.auth }), requests: (f.requests || []).filter((r) => want.has(`${f.name}/${r.name}`)) })).filter((f) => f.requests.length);
  const requests = (cfg.requests || []).filter((r) => want.has(r.name));
  const used = new Set([...folders.flatMap((f) => [f.auth, ...f.requests.map((r) => r.auth)]), ...requests.map((r) => r.auth)].filter((a) => a?.type === 'token').map((a) => a.source));
  return { version: 1, ...(cfg.tokenSources && { tokenSources: cfg.tokenSources.filter((t) => used.has(t.name)) }), folders, requests };
}

export const summaryText = (s) => Object.entries(s).map(([k, n]) => `${n} ${k}`).join(', ') || 'no changes';
