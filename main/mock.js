'use strict';
// Mock server from a spec: serves each operation's example response on localhost. The renderer
// builds the route table from the spec (renderer/app/openapi/mock.js), so this side only matches
// method + path template and replies.
// Per request, the status can be forced with an `X-Mock-Status: 503` header or `?__status=503`;
// per route, with the override chosen in the app; "drop" closes the connection without a reply.
const http = require('http');
const { windows, alive } = require('./windows');

const servers = new Map(); // id → { server, routes, delayMs, port, basePath }

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

function reply(state, req, res, onHit) {
  const t0 = Date.now();
  const url = new URL(req.url, 'http://mock');
  let path = url.pathname;
  if (state.basePath && path.startsWith(state.basePath)) path = path.slice(state.basePath.length) || '/';
  const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD' };
  const log = (status, routeKey) => onHit({ id: state.id, at: Date.now(), method: req.method, url: req.url, status, route: routeKey, ms: Date.now() - t0 });
  if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) { res.writeHead(204, cors); res.end(); return log(204, 'CORS preflight'); }
  const route = match(state.routes, req.method, path);
  const send = (status, body, contentType, headers = {}) => {
    res.writeHead(status, { ...headers, ...cors, ...(body != null && { 'Content-Type': contentType || 'application/json' }), 'X-Mock': 'api-workbench' });
    res.end(req.method === 'HEAD' || body == null ? undefined : body);
    log(status, route ? `${route.method} ${route.path}` : null);
  };
  if (!route) return send(404, JSON.stringify({ error: 'No operation in the spec matches', method: req.method, path }), 'application/json');
  const forced = req.headers['x-mock-status'] || url.searchParams.get('__status') || route.override || state.override;
  if (forced === 'drop') { req.socket.destroy(); return log('dropped', `${route.method} ${route.path}`); }
  const code = forced && forced !== 'auto' ? String(forced) : route.defaultCode || firstSuccess(route.responses);
  const r = route.responses[code] || route.responses.default;
  const status = /^\d{3}$/.test(code) ? +code : 200;
  if (r) return send(status, r.bodyBase64 != null ? Buffer.from(r.bodyBase64, 'base64') : r.body, r.contentType, r.headers);
  // A status the spec doesn't describe: a generic problem body.
  send(status, JSON.stringify({ type: 'about:blank', title: http.STATUS_CODES[status] || 'Error', status, detail: 'Mocked error (not described in the spec)' }), 'application/problem+json');
}

async function start({ id, routes, port = 0, delayMs = 0, basePath = '', override = '' }, onHit) {
  await stop(id);
  const state = { id, routes, delayMs, basePath: basePath.replace(/\/$/, ''), override };
  const server = http.createServer((req, res) => {
    req.resume(); // the body isn't used
    setTimeout(() => reply(state, req, res, onHit), state.delayMs);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  state.server = server; state.port = server.address().port;
  servers.set(id, state);
  return { port: state.port, url: `http://127.0.0.1:${state.port}${state.basePath}` };
}

// Changes routes / overrides / latency of a running mock without restarting it.
function update({ id, routes, delayMs, override }) {
  const s = servers.get(id); if (!s) return false;
  if (routes) s.routes = routes;
  if (delayMs != null) s.delayMs = delayMs;
  if (override != null) s.override = override;
  return true;
}

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
}

module.exports = { start, stop, update, running, match, compile, register };
