// The MCP server's tools (main/mcp.js has the protocol, the tool list and the HTTP listener; calls arrive
// here because the data, variables and send pipeline live in the app window). Each tool returns a plain
// object that the client sees as JSON. With "Hide credentials" on (the default) credential headers, secret
// values the app holds, and passwords / tokens / keys in URLs and bodies are removed from what it returns.
import { DB, S, currentProject, findReq, allRequests, newReq, saveDB } from './store.js';
import { send, buildRequest } from './http.js';
import { attachValidation } from './verify.js';
import { recordHistory, historyEntries } from './history.js';
import { runCollection, requestsInScope, summarize } from './runner.js';
import { searchItems, searchApi } from './search.js';
import { specAnalysis, ensureProjectSpecs } from './openapi/registry.js';
import { fieldRows } from './openapi/docs.js';
import { deref } from './openapi/spec.js';
import { logIdsFor } from './tasks.js';
import { applyConfig } from './config.js';
import { redactCredentials } from '../shared/redact.js';

const MAX_BODY = 20000;
const CREDENTIAL_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const settings = () => DB.settings.mcp || {};
const hiding = () => settings().redact !== false;

// ---- what the client sees

// Every secret value the app holds, to remove wherever it shows up.
function secretValues() {
  const out = [];
  const auth = (a) => { if (a?.token) out.push(a.token); if (a?.pass) out.push(a.pass); };
  for (const p of DB.projects) {
    auth(p.auth); p.folders.forEach((f) => auth(f.auth)); allRequests(p).forEach((r) => auth(r.auth));
    for (const c of String(p.cookies || '').split(';')) { const v = c.split('=').slice(1).join('=').trim(); if (v) out.push(v); }
    for (const e of p.envs) { for (const v of e.vars) if (v.secret && v.v) out.push(v.v); if (e.network?.passphrase) out.push(e.network.passphrase); }
  }
  return [...new Set(out.filter((v) => typeof v === 'string' && v.length >= 4 && !/^\{\{.*\}\}$/.test(v)))].sort((a, b) => b.length - a.length);
}
function clean(text) {
  if (!hiding() || typeof text !== 'string' || !text) return text;
  let s = text;
  for (const v of secretValues()) s = s.split(v).join('[redacted]');
  return redactCredentials(s);
}
const cleanHeaders = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k, hiding() && CREDENTIAL_HEADERS.test(k) ? '[redacted]' : clean(String(v))]));
const short = (text) => { const s = clean(String(text ?? '')); return s.length > MAX_BODY ? { body: s.slice(0, MAX_BODY), truncated: true, length: s.length } : { body: s }; };

// A send() result as the client sees it.
function responseOut(res) {
  if (res.error) return { error: res.error, request: res.requestData && { method: res.requestData.method, url: clean(res.requestData.url) } };
  return {
    request: { method: res.requestData?.method, url: clean(res.requestData?.url) },
    status: res.status, statusText: res.statusText, timeMs: res.time,
    headers: cleanHeaders(res.headers), ...short(res.body),
    ...(res.assertionResults?.length && { assertions: res.assertionResults.map((a) => ({ expression: a.expr, passed: !!a.ok, ...(a.err && { error: a.err }) })) }),
    ...(res.validation?.op && { specCheck: { operation: res.validation.op, request: (res.validation.request || []).map((i) => `${i.where}: ${i.message}`), response: (res.validation.response || []).map((i) => `${i.where}: ${i.message}`) } }),
    ...(res.warnings?.length && { warnings: res.warnings.map(clean) }),
    ...(res.snapshotResult && { snapshot: res.snapshotResult.matches ? 'matches' : `${res.snapshotResult.diffs.length} difference(s)` }),
    ...(res.slow && { slow: `${res.slow.ratio.toFixed(1)}× slower than usual (p50 ${res.slow.p50} ms)` }),
  };
}

// ---- finding things by name

function projectFor(ref) {
  if (!ref) { const p = currentProject() || DB.projects[0]; if (!p) throw new Error('There are no projects in API Workbench yet'); return p; }
  const want = String(ref).toLowerCase();
  const p = DB.projects.find((x) => x.id === ref) || DB.projects.find((x) => x.name.toLowerCase() === want);
  if (!p) throw new Error(`No project "${ref}". Projects: ${DB.projects.map((x) => `"${x.name}"`).join(', ') || 'none'}`);
  return p;
}
const pathOf = (loc) => (loc.f ? `${loc.f.name}/${loc.r.name}` : loc.r.name);
function requestFor(ref, projectRef) {
  const byId = findReq(ref); if (byId) return byId;
  const p = projectFor(projectRef);
  const all = allRequests(p).map((r) => findReq(r.id));
  const want = String(ref).toLowerCase();
  const hits = all.filter((l) => pathOf(l).toLowerCase() === want);
  const named = hits.length ? hits : all.filter((l) => l.r.name.toLowerCase() === want);
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new Error(`"${ref}" matches ${named.length} requests: use one of ${named.map((l) => `"${pathOf(l)}"`).join(', ')}`);
  throw new Error(`No request "${ref}" in ${p.name}. Use list_requests or search to find it.`);
}
function envFor(p, name) {
  if (!name) return undefined;
  const e = p.envs.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!e) throw new Error(`No environment "${name}" in ${p.name}. Environments: ${p.envs.map((x) => `"${x.name}"`).join(', ') || 'none'}`);
  return e;
}
// send_http and save_request take a URL from the client, but what's sent carries the project's auth, cookies
// and {{secret}} variables. So they only go to hosts the project already uses (its saved requests and URL
// variables, in any environment); otherwise a client steered by a prompt injection could send those anywhere.
const hostOf = (url) => { try { const u = new URL(url); return /^(https?|wss?):$/.test(u.protocol) ? u.host : null; } catch { return null; } };
function knownHosts(p) {
  const hosts = new Set();
  const add = (url) => { const h = hostOf(url); if (h) hosts.add(h); };
  for (const env of p.envs.length ? p.envs : [undefined]) {
    for (const r of allRequests(p)) add(buildRequest({ p, f: null, r }, { env }).url);
    for (const v of env?.vars || []) add(v.v);
  }
  return hosts;
}
function checkHost(p, url, env) {
  const target = buildRequest({ p, f: null, r: newReq({ url }) }, { env }).url;
  const host = hostOf(target);
  if (!host) throw new Error(`${clean(target)} isn't an absolute http(s) URL (after filling in {{variables}})`);
  const known = knownHosts(p);
  if (!known.has(host)) {
    throw new Error(clean(`${host} isn't a host ${p.name} uses (${[...known].join(', ') || 'none yet'}). Requests from MCP carry the project's credentials, so they only go to hosts its saved requests or URL variables already use: add a request or variable for ${host} in API Workbench first.`));
  }
}

async function sendLoc(loc, { env, vars } = {}) {
  const res = await attachValidation(loc, await send(loc, undefined, { env, vars }));
  recordHistory(loc, res, { envId: env?.id ?? loc.p.activeEnv });
  return res;
}

// ---- the tools

const TOOLS = {
  list_projects() {
    return { selected: currentProject()?.name ?? null, projects: DB.projects.map((p) => ({
      id: p.id, name: p.name, requests: allRequests(p).length, folders: p.folders.map((f) => f.name),
      environments: p.envs.map((e) => (e.id === p.activeEnv ? `${e.name} (active)` : e.name)),
      specs: p.specs.map((s) => `${s.title}${s.version ? ' ' + s.version : ''} (${s.operationCount} operations)`), codeFolder: p.codeFolder || null,
    })) };
  },
  list_requests({ project, folder }) {
    const p = projectFor(project);
    const f = folder && p.folders.find((x) => x.name.toLowerCase() === String(folder).toLowerCase());
    if (folder && !f) throw new Error(`No folder "${folder}" in ${p.name}. Folders: ${p.folders.map((x) => `"${x.name}"`).join(', ') || 'none'}`);
    const locs = (f ? f.requests : allRequests(p)).map((r) => findReq(r.id));
    return { project: p.name, requests: locs.map((l) => ({ id: l.r.id, folder: l.f?.name ?? null, name: l.r.name, method: l.r.kind && l.r.kind !== 'http' ? l.r.kind.toUpperCase() : l.r.method, url: clean(l.r.url) })) };
  },
  get_request({ request, project }) {
    const { p, f, r } = requestFor(request, project);
    return {
      id: r.id, project: p.name, folder: f?.name ?? null, name: r.name, kind: r.kind || 'http', method: r.method, url: clean(r.url),
      headers: Object.fromEntries(r.headers.filter((h) => h.k).map((h) => [h.k, hiding() && CREDENTIAL_HEADERS.test(h.k) && !/^\{\{.*\}\}$/.test(h.v) ? '[redacted]' : clean(h.v)])),
      body: r.body.type === 'none' ? null : r.body.type === 'form' ? { form: Object.fromEntries(r.body.form.filter((x) => x.k).map((x) => [x.k, clean(x.v)])) } : { type: r.body.type, text: clean(r.body.text) },
      auth: r.auth.type, assertions: r.assertions, extract: r.chain.filter((c) => c.k).map((c) => `${c.k} → ${c.v || 'bearer'}`),
      ...(r.spec?.opKey && { operation: r.spec.opKey }), ...(r.graphql && { graphql: r.graphql }), ...(r.grpc && { grpc: { service: r.grpc.service, method: r.grpc.method } }),
    };
  },
  list_environments({ project }) {
    const p = projectFor(project);
    return { project: p.name, environments: p.envs.map((e) => ({ name: e.name, active: e.id === p.activeEnv,
      variables: Object.fromEntries(e.vars.filter((v) => v.k).map((v) => [v.k, v.secret ? '[secret]' : v.on === false ? `${clean(v.v)} (off)` : clean(v.v)])) })) };
  },
  async send_request({ request, project, environment, variables }) {
    const loc = requestFor(request, project);
    return { request: pathOf(loc), ...responseOut(await sendLoc(loc, { env: envFor(loc.p, environment), vars: variables || {} })) };
  },
  async send_http({ method, url, headers, body, project, environment }) {
    const p = projectFor(project);
    const env = envFor(p, environment);
    checkHost(p, url, env);
    const isJson = body !== undefined && typeof body !== 'string';
    const r = newReq({ name: `MCP: ${method} ${url}`.slice(0, 80), method, url,
      headers: [...Object.entries(headers || {}).map(([k, v]) => ({ k, v: String(v), on: true })), ...(isJson && !Object.keys(headers || {}).some((k) => k.toLowerCase() === 'content-type') ? [{ k: 'Content-Type', v: 'application/json', on: true }] : [])],
      body: body === undefined || body === null ? { type: 'none', text: '', form: [] } : { type: isJson ? 'json' : 'raw', text: isJson ? JSON.stringify(body, null, 2) : body, form: [] } });
    return responseOut(await sendLoc({ p, f: null, r }, { env }));
  },
  async run_collection({ project, folder, feature, environment, iterations = 1 }) {
    let scope, label;
    if (feature) {
      const ft = DB.features.find((x) => x.name.toLowerCase() === String(feature).toLowerCase());
      if (!ft) throw new Error(`No feature group "${feature}". Feature groups: ${DB.features.map((x) => `"${x.name}"`).join(', ') || 'none'}`);
      scope = { type: 'feature', id: ft.id }; label = `feature ${ft.name}`;
    } else {
      const p = projectFor(project);
      const f = folder && p.folders.find((x) => x.name.toLowerCase() === String(folder).toLowerCase());
      if (folder && !f) throw new Error(`No folder "${folder}" in ${p.name}`);
      scope = f ? { type: 'folder', id: f.id, projectId: p.id } : { type: 'project', id: p.id, projectId: p.id }; label = f ? `${p.name} / ${f.name}` : p.name;
    }
    const locs = requestsInScope(scope);
    if (!locs.length) throw new Error(`Nothing to run in ${label}`);
    const env = environment ? envFor(locs[0].p, environment) : undefined;
    const results = [];
    await runCollection(locs, (loc, vars) => sendLoc(loc, { env, vars }), { iterations: Math.min(20, Math.max(1, iterations)) }, (r) => results.push(r));
    const s = summarize(results);
    return { ran: label, passed: s.passed, failed: s.failed, total: s.total, timeMs: s.time,
      results: results.map((r) => ({ request: r.name, status: r.status, timeMs: r.time, passed: r.passed, ...(r.failures.length && { failures: r.failures.map(clean) }), ...(r.error && { error: r.error }) })) };
  },
  async search({ query, limit = 20 }) {
    await Promise.all(DB.projects.map((p) => ensureProjectSpecs(p)));
    return { results: searchApi(searchItems(DB.projects, specAnalysis), query, Math.min(50, limit)).map((i) => (i.kind === 'request'
      ? { kind: 'request', project: i.projectName, folder: i.folder || null, name: i.title, method: i.method, url: clean(i.path), id: i.id }
      : { kind: 'operation', project: i.projectName, spec: i.specTitle, operation: i.opKey, summary: i.title || null, operationId: i.operationId || null, ...(i.deprecated && { deprecated: true }) })) };
  },
  async get_operation({ operation, project }) {
    const p = projectFor(project);
    await ensureProjectSpecs(p);
    const key = String(operation).trim().replace(/^(\w+)\s+/, (_m, v) => v.toUpperCase() + ' ');
    for (const meta of p.specs) {
      const a = specAnalysis(meta.id); if (!a) continue;
      const op = a.byKey.get(key) || a.operations.find((o) => o.operationId === operation);
      if (!op) continue;
      const fields = (schema) => (schema ? fieldRows(deref(a.doc, schema) || schema, a.doc, { maxRows: 80 }).map((f) => `${f.path}: ${f.type}${f.required ? ' (required)' : ''}${f.description ? ' — ' + f.description.slice(0, 120) : ''}`) : []);
      const content = (c) => Object.fromEntries(Object.entries(c || {}).map(([type, m]) => [type, fields(m.schema)]));
      return { spec: meta.title, operation: op.key, operationId: op.operationId || null, summary: op.summary || null, description: op.description || null, deprecated: op.deprecated || undefined,
        parameters: op.parameters.map((x) => ({ name: x.name, in: x.in, required: !!x.required, type: x.schema?.type || null, description: x.description || null })),
        requestBody: op.requestBody ? { required: !!op.requestBody.required, content: content(op.requestBody.content) } : null,
        responses: Object.fromEntries(Object.entries(op.responses || {}).map(([code, r]) => [code, { description: r.description || '', content: content(r.content) }])) };
    }
    throw new Error(`No operation "${operation}" in ${p.name}'s specs${p.specs.length ? '' : ' (it has none attached)'}. Use search to find it.`);
  },
  history({ request, project, limit = 10 }) {
    let list = historyEntries();
    if (request) { const loc = requestFor(request, project); list = list.filter((e) => e.reqId === loc.r.id); }
    else if (project) { const p = projectFor(project); list = list.filter((e) => e.projectId === p.id); }
    return { sends: list.slice(0, Math.min(50, limit)).map((e) => ({ at: new Date(e.at).toISOString(), request: e.reqName, method: e.method, url: clean(e.url),
      ...(e.response ? { status: e.response.status, timeMs: e.response.time, ...short(e.response.body) } : { error: e.error }) })) };
  },
  async find_logs({ text, project }) {
    if (String(text || '').length < 6) throw new Error('Give at least 6 characters to look for');
    const p = projectFor(project);
    const groups = await window.electronAPI.logsFind(logIdsFor(p), [text]);
    return { project: p.name, sources: groups.map((g) => ({ source: g.name, lines: g.lines.slice(0, 200).map((l) => clean(l.text)) })),
      ...(!groups.length && { note: 'No matches in the log lines of running tasks and followed log sources (the app keeps the recent lines of each).' }) };
  },
  save_request({ name, project, folder, method, url, headers, json, body, assertions }) {
    const p = projectFor(project);
    checkHost(p, url); // a saved request is sent later with the project's auth, and its host then counts as known
    const entry = { name, url, ...(method && { method }), ...(headers && { headers }), ...(json !== undefined && { json }), ...(body !== undefined && { body }), ...(assertions && { assertions }) };
    const res = applyConfig(folder ? { folders: [{ name: folder, requests: [entry] }] } : { requests: [entry] }, { project: p, adoptCodeFolder: false });
    saveDB();
    const loc = requestFor(folder ? `${folder}/${name}` : name, p.id);
    if (globalThis.document) import('./views/index.js').then((m) => m.renderAll());
    return { saved: pathOf(loc), id: loc.r.id, created: !!res.summary.requests, ...(res.warnings.length && { warnings: res.warnings }) };
  },
};

export const MCP_TOOLS = Object.keys(TOOLS);
export async function callTool(name, args = {}) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(args || {});
}

// Answers the main process's tool calls, and starts the server if it was on when the app last ran.
export function initMcp() {
  const api = window.electronAPI;
  api.onMcpCall?.(async ({ id, name, args }) => {
    try { api.mcpResult({ id, ok: true, value: await callTool(name, args) }); } catch (err) { api.mcpResult({ id, ok: false, error: err.message }); }
  });
  const m = settings();
  if (m.enabled && m.token) api.mcpStart({ port: m.port || 3920, token: m.token, allowEdits: !!m.allowEdits }).then((r) => { S.mcp = r; });
  // Launched with --mcp (npm run start:mcp): switch it on, as the Settings checkbox would.
  else api.mcpLaunchRequest?.().then((asked) => { if (asked) import('./actions/mcp.js').then((x) => x.setMcpEnabled(true)); });
}
