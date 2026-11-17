'use strict';
// Mock server from a spec: serves each operation's example response on localhost. The renderer
// builds the route table from the spec (renderer/app/openapi/mock.js), so this side only matches
// method + path template and replies.
// Per request, the status can be forced with an `X-Mock-Status: 503` header or `?__status=503`;
// per route, with the override chosen in the app; "drop" closes the connection without a reply.
//
// Stateful mode remembers what clients write, in memory: POST to a collection path stores the body (with an id),
// GET / PUT / PATCH / DELETE on <collection>/{id} read, replace, merge and remove it, and GET on the collection
// lists what's stored. Until something is written to a collection, its paths answer with the examples.
//
// Faults (for testing retries and timeouts), never applied to a forced status:
//   errorRate: % of requests answered with errorStatus ('500' … '504', '429', 'drop' closes the connection,
//   'hang' never answers); failFirst: the first N calls to each method + path fail the same way, then succeed;
//   jitterMs: up to this much extra latency at random; slowRate / slowMs: % of requests delayed by slowMs more.
const http = require('http');
const crypto = require('crypto');
const { windows, alive } = require('./windows');

const servers = new Map(); // id → { server, routes, delayMs, port, basePath, stateful, faults, store, attempts, random }
const FAULT_DEFAULTS = { errorRate: 0, errorStatus: '503', failFirst: 0, jitterMs: 0, slowRate: 0, slowMs: 0 };
const MAX_BODY = 1024 * 1024; // request bodies kept by stateful mode
const MAX_HANG_MS = 10 * 60 * 1000;

// '/pets/{id}' → /^\/pets\/([^/]+)$/
const compile = (path) => new RegExp('^' + path.split(/\{[^}]+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([^/]+)') + '/?$');

// routes: [{ method, path, responses: { '200': { contentType, body | bodyBase64, headers? } }, override?: '404' | 'drop',
//            defaultCode?: '200' (recorded traffic: the latest status; else the first 2xx) }]
function match(routes, method, path) {
  // Literal segments beat templated ones: /pets/mine before /pets/{id}.
  const hits = routes.filter((r) => (r.method === method || (method === 'HEAD' && r.method === 'GET')) && (r.re ||= compile(r.path)).test(path));
  return hits.sort((a, b) => (a.path.match(/\{/g) || []).length - (b.path.match(/\{/g) || []).length)[0] || null;
}

const firstSuccess = (responses) => Object.keys(responses).sort().find((c) => /^2/.test(c)) || Object.keys(responses).find((c) => c === 'default') || Object.keys(responses)[0];

const problem = (status, detail) => JSON.stringify({ type: 'about:blank', title: http.STATUS_CODES[status] || 'Error', status, detail });

// The path below the mock's base path.
function routePath(state, url) {
  const path = url.pathname;
  return state.basePath && path.startsWith(state.basePath) ? path.slice(state.basePath.length) || '/' : path;
}

// A fault for this request, if any: { status: '503' | 'drop' | 'hang', why: 'random' | 'fail-first' }.
function pickFault(state, method, path) {
  const f = state.faults;
  if (f.failFirst > 0) {
    const key = `${method} ${path}`;
    const n = (state.attempts.get(key) || 0) + 1;
    state.attempts.set(key, n);
    if (n <= f.failFirst) return { status: f.errorStatus, why: `fail-first ${n}/${f.failFirst}` };
  }
  if (f.errorRate > 0 && state.random() * 100 < f.errorRate) return { status: f.errorStatus, why: 'random' };
  return null;
}

function reply(state, req, res, onHit, rawBody) {
  const t0 = req.receivedAt || Date.now();
  const url = new URL(req.url, 'http://mock');
  const path = routePath(state, url);
  const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD', 'Access-Control-Expose-Headers': 'X-Mock, X-Mock-Fault, X-Mock-State, Retry-After' };
  const log = (status, routeKey, note) => onHit({ id: state.id, at: Date.now(), method: req.method, url: req.url, status, route: routeKey, ms: Date.now() - t0, ...(note && { note }) });
  if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) { res.writeHead(204, cors); res.end(); return log(204, 'CORS preflight'); }
  const route = match(state.routes, req.method, path);
  const routeKey = route ? `${route.method} ${route.path}` : null;
  const send = (status, body, contentType, headers = {}, note) => {
    res.writeHead(status, { ...headers, ...cors, ...(body != null && { 'Content-Type': contentType || 'application/json' }), 'X-Mock': 'api-workbench' });
    res.end(req.method === 'HEAD' || body == null ? undefined : body);
    log(status, routeKey, note);
  };
  if (!route) return send(404, JSON.stringify({ error: 'No operation in the spec matches', method: req.method, path }), 'application/json');
  const forced = req.headers['x-mock-status'] || url.searchParams.get('__status') || route.override || state.override;
  if (forced === 'drop') { req.socket.destroy(); return log('dropped', routeKey); }
  if (forced && forced !== 'auto') return sendCode(String(forced));

  const fault = pickFault(state, req.method, path);
  if (fault) {
    const note = `fault: ${fault.why}`;
    if (fault.status === 'drop') { req.socket.destroy(); return log('dropped', routeKey, note); }
    if (fault.status === 'hang') {
      // Never answers; the connection closes when the client gives up, the mock stops, or after 10 minutes.
      const timer = setTimeout(() => req.socket.destroy(), MAX_HANG_MS);
      req.socket.once('close', () => clearTimeout(timer));
      return log('hung', routeKey, note);
    }
    const status = /^\d{3}$/.test(fault.status) ? +fault.status : 503;
    const headers = { 'X-Mock-Fault': fault.why, ...([429, 503].includes(status) && { 'Retry-After': '1' }) };
    const r = route.responses[String(status)];
    return r ? send(status, r.bodyBase64 != null ? Buffer.from(r.bodyBase64, 'base64') : r.body, r.contentType, { ...r.headers, ...headers }, note)
      : send(status, problem(status, `Injected fault (${fault.why})`), 'application/problem+json', headers, note);
  }

  if (state.stateful) {
    const out = statefulReply(state, route, req.method, path, rawBody);
    if (out) return send(out.status, out.body === null ? null : JSON.stringify(out.body, null, 2), out.contentType || 'application/json', { 'X-Mock-State': out.note }, out.note);
  }
  return sendCode(route.defaultCode || firstSuccess(route.responses));

  function sendCode(code) {
    const r = route.responses[code] || route.responses.default;
    const status = /^\d{3}$/.test(code) ? +code : 200;
    if (r) return send(status, r.bodyBase64 != null ? Buffer.from(r.bodyBase64, 'base64') : r.body, r.contentType, r.headers);
    // A status the spec doesn't describe: a generic problem body.
    send(status, problem(status, 'Mocked error (not described in the spec)'), 'application/problem+json');
  }
}

// ---- Stateful mode
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const parse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
// The route's example body for the first of `codes` it documents (parsed JSON), or undefined.
function example(route, codes) {
  for (const c of codes) { const r = route.responses[c]; if (r?.body != null && r.bodyBase64 == null) { const v = parse(r.body); if (v !== undefined) return v; } }
  return undefined;
}
// The example's fields a stored item starts from: the response schema's required ones (fill), so the
// answer stays valid without inventing optional values the client never sent; all of it when unknown.
function template(route, codes) {
  const code = codes.find((c) => route.responses[c]?.body != null);
  const v = code && example(route, [code]);
  if (!isObj(v)) return {};
  const fill = route.responses[code].fill;
  return Array.isArray(fill) ? Object.fromEntries(Object.entries(v).filter(([k]) => fill.includes(k))) : v;
}
// The documented success code closest to `prefer` (201 for a create …), else prefer.
const successCode = (route, prefer) => (route.responses[String(prefer)] ? prefer : +(Object.keys(route.responses).sort().find((c) => /^2\d\d$/.test(c)) || prefer));
const ID_KEYS = ['id', 'uuid', '_id', 'key'];
function idFieldOf(...objs) {
  for (const k of ID_KEYS) if (objs.some((o) => isObj(o) && k in o)) return k;
  for (const o of objs) if (isObj(o)) { const k = Object.keys(o).find((x) => /(^|[a-z_])(id|Id|ID)$/.test(x)); if (k) return k; }
  return 'id';
}
function collection(state, key) {
  if (!state.store.has(key)) state.store.set(key, { items: new Map(), nextId: 1, idField: null, numeric: true });
  return state.store.get(key);
}
// A new id for the collection: the next number, or a UUID when its ids are strings.
function newId(coll) {
  if (!coll.numeric) return crypto.randomUUID();
  while (coll.items.has(String(coll.nextId))) coll.nextId++;
  return coll.nextId++;
}
const typedId = (coll, id) => (coll.numeric && /^\d+$/.test(id) ? Number(id) : id);

// → { status, body (null = none), note } or null to answer with the example as usual.
function statefulReply(state, route, method, path, rawBody) {
  const clean = path.replace(/\/$/, '') || '/';
  const isItem = /\{[^}/]+\}$/.test(route.path.replace(/\/$/, ''));
  const body = rawBody ? parse(rawBody) : undefined;
  if (['POST', 'PUT', 'PATCH'].includes(method) && rawBody && body === undefined) return { status: 400, body: { title: 'Bad Request', status: 400, detail: 'Stateful mock: the request body is not JSON' }, contentType: 'application/problem+json', note: 'state: bad JSON' };

  if (!isItem) {
    const coll = state.store.get(clean);
    if (method === 'POST' && isObj(body)) {
      const c = collection(state, clean);
      const full = example(route, ['201', '200']);
      c.idField ||= idFieldOf(body, full);
      if (c.items.size === 0 && typeof (body[c.idField] ?? full?.[c.idField]) === 'string') c.numeric = false;
      const id = body[c.idField] ?? newId(c);
      const item = { ...template(route, ['201', '200']), ...body, [c.idField]: id };
      c.items.set(String(id), item); c.touched = true;
      return { status: successCode(route, 201), body: item, note: `state: created ${c.idField} ${id} in ${clean}` };
    }
    if (method === 'GET' && coll?.touched) {
      const list = [...coll.items.values()];
      const shape = example(route, ['200']);
      if (isObj(shape)) {
        // A page object ({ items: [...], total: n }): its first array holds the list; counts follow it.
        const arrayKey = Object.keys(shape).find((k) => Array.isArray(shape[k]));
        if (arrayKey) {
          const page = { ...shape, [arrayKey]: list };
          for (const k of ['total', 'count', 'totalCount', 'totalElements', 'totalItems', 'size']) if (typeof shape[k] === 'number') page[k] = list.length;
          return { status: 200, body: page, note: `state: ${list.length} in ${clean}` };
        }
      }
      return { status: 200, body: list, note: `state: ${list.length} in ${clean}` };
    }
    return null;
  }

  const segs = clean.split('/');
  const rawId = decodeURIComponent(segs.pop());
  const key = segs.join('/') || '/';
  const coll = state.store.get(key);
  const item = coll?.items.get(rawId);
  const missing = () => ({ status: 404, body: { title: 'Not Found', status: 404, detail: `Stateful mock: nothing with id ${rawId} in ${key}` }, contentType: 'application/problem+json', note: `state: no ${rawId} in ${key}` });
  switch (method) {
    case 'GET':
      if (item) return { status: 200, body: item, note: `state: read ${rawId} from ${key}` };
      return coll?.touched ? missing() : null;
    case 'PUT': {
      if (!isObj(body)) return null;
      const c = collection(state, key);
      c.idField ||= idFieldOf(body, item);
      const next = { ...body, [c.idField]: typedId(c, rawId) };
      c.items.set(rawId, next); c.touched = true;
      return { status: successCode(route, 200), body: next, note: `state: ${item ? 'replaced' : 'created'} ${rawId} in ${key}` };
    }
    case 'PATCH': {
      if (!item && coll?.touched) return missing();
      if (!isObj(body)) return null;
      const c = collection(state, key);
      c.idField ||= idFieldOf(body, item);
      const base = item || template(route, ['200']);
      const next = { ...base, ...body, [c.idField]: typedId(c, rawId) };
      c.items.set(rawId, next); c.touched = true;
      return { status: successCode(route, 200), body: next, note: `state: updated ${rawId} in ${key}` };
    }
    case 'DELETE': {
      if (!item && coll?.touched) return missing();
      const c = collection(state, key);
      c.items.delete(rawId); c.touched = true;
      const status = successCode(route, 204);
      return { status, body: status === 204 ? null : item || null, note: `state: deleted ${rawId} from ${key}` };
    }
    default: return null;
  }
}

// What stateful mode holds: [{ path, count }]
const storeSummary = (state) => [...state.store].filter(([, c]) => c.touched).map(([path, c]) => ({ path, count: c.items.size }));

async function start({ id, routes, port = 0, delayMs = 0, basePath = '', override = '', stateful = false, faults = {}, random = Math.random }, onHit) {
  await stop(id);
  const state = { id, routes, delayMs, basePath: basePath.replace(/\/$/, ''), override, stateful: !!stateful, faults: { ...FAULT_DEFAULTS, ...faults },
    store: new Map(), attempts: new Map(), random };
  const server = http.createServer((req, res) => {
    req.receivedAt = Date.now();
    // Stateful mode reads JSON bodies (up to 1 MB); otherwise the body isn't used.
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (state.stateful && size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      const f = state.faults;
      const extra = (f.jitterMs > 0 ? Math.round(state.random() * f.jitterMs) : 0) + (f.slowRate > 0 && state.random() * 100 < f.slowRate ? f.slowMs : 0);
      const body = state.stateful && size && size <= MAX_BODY ? Buffer.concat(chunks).toString('utf8') : '';
      setTimeout(() => reply(state, req, res, onHit, body), state.delayMs + extra);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  state.server = server; state.port = server.address().port;
  servers.set(id, state);
  return { port: state.port, url: `http://127.0.0.1:${state.port}${state.basePath}` };
}

// Changes routes / overrides / latency / stateful mode / faults of a running mock without restarting it.
function update({ id, routes, delayMs, override, stateful, faults }) {
  const s = servers.get(id); if (!s) return false;
  if (routes) s.routes = routes;
  if (delayMs != null) s.delayMs = delayMs;
  if (override != null) s.override = override;
  if (stateful != null) s.stateful = !!stateful;
  if (faults) { s.faults = { ...FAULT_DEFAULTS, ...faults }; s.attempts.clear(); }
  return true;
}

// Forgets what stateful mode stored and the fail-first counters. → the (empty) store summary
function reset(id) {
  const s = servers.get(id); if (!s) return null;
  s.store.clear(); s.attempts.clear();
  return storeSummary(s);
}
const stateOf = (id) => { const s = servers.get(id); return s ? storeSummary(s) : null; };

function stop(id) {
  const s = servers.get(id); if (!s) return Promise.resolve(false);
  servers.delete(id);
  s.server.closeAllConnections?.();
  return new Promise((r) => s.server.close(() => r(true)));
}

const running = () => [...servers.values()].map((s) => ({ id: s.id, port: s.port, basePath: s.basePath }));

function register(ipcMain) {
  const onHit = (hit) => alive(windows.main)?.webContents.send('mock-hit', hit);
  const guard = (fn) => async (_e, arg) => { try { return { ok: true, ...(await fn(arg)) }; } catch (err) { return { ok: false, error: err.code === 'EADDRINUSE' ? `Port ${arg.port} is already in use` : err.message }; } };
  ipcMain.handle('mock-start', guard((opts) => start(opts, onHit)));
  ipcMain.handle('mock-update', guard((opts) => ({ updated: update(opts) })));
  ipcMain.handle('mock-stop', guard(async (id) => ({ stopped: await stop(id) })));
  ipcMain.handle('mock-list', () => running());
  ipcMain.handle('mock-reset', guard((id) => ({ store: reset(id) })));
  ipcMain.handle('mock-state', guard((id) => ({ store: stateOf(id) })));
}

module.exports = { start, stop, update, reset, stateOf, running, match, compile, register };
