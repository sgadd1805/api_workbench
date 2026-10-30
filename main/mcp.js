'use strict';
// MCP server: lets an MCP client (Claude Code, Claude Desktop, or any other) use the running app — list and
// inspect requests, send them or ad-hoc calls, run collections, search specs, read History and logs.
// Off by default (Settings → MCP server). Streamable HTTP on 127.0.0.1 only, JSON responses (no SSE stream),
// and every request needs the bearer token shown in Settings; Host and Origin are checked so a web page in a
// browser can't reach it (DNS rebinding). bin/api-workbench-mcp.js bridges stdio clients to it, using the
// port and token this module writes to <userData>/mcp.json (readable by your user account only).
// The tools run in the app window (renderer/app/mcp.js), where the data, variables and send pipeline live.
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 4 * 1024 * 1024;

const str = (description) => ({ type: 'string', description });
const REQUEST_REF = str('A saved request: its id, "Folder/Request name", or a request name (unique in the project).');
const PROJECT_REF = str('Project name or id. Default: the project selected in the app.');
const ENV_REF = str('Environment name. Default: the project\'s active environment.');
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: false };

// name → { title, description, inputSchema, annotations, edits? (needs "Allow changes") }
const TOOLS = {
  list_projects: { title: 'List projects', description: 'Projects in API Workbench, with their environments (active one marked), folders, request counts and attached API specs.',
    inputSchema: obj({}), annotations: RO },
  list_requests: { title: 'List requests', description: 'Saved requests of a project (or one folder): id, folder, name, method and URL (with {{variables}}).',
    inputSchema: obj({ project: PROJECT_REF, folder: str('Only this folder.') }), annotations: RO },
  get_request: { title: 'Get a request', description: 'A saved request in full: method, URL, headers, body, auth type, assertions, extract rules, linked spec operation. Secret values are left out.',
    inputSchema: obj({ request: REQUEST_REF, project: PROJECT_REF }, ['request']), annotations: RO },
  list_environments: { title: 'List environments', description: 'A project\'s environments and their variables. Secret variables show as [secret].',
    inputSchema: obj({ project: PROJECT_REF }), annotations: RO },
  send_request: { title: 'Send a saved request', description: 'Sends a saved request the way the app does (environment variables, auth and token sources, scripts, extract rules) and returns the status, time, headers, body (shortened), assertion results and spec check. Extract rules may update environment variables; the send is added to History.',
    inputSchema: obj({ request: REQUEST_REF, project: PROJECT_REF, environment: ENV_REF, variables: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra {{variables}} for this send only.' } }, ['request']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  send_http: { title: 'Send an HTTP request', description: 'Sends an ad-hoc HTTP request in a project\'s context: {{variables}} from its environment and the project\'s auth apply. Nothing is saved except a History entry.',
    inputSchema: obj({ method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] }, url: str('Absolute URL; may use {{variables}}, e.g. {{baseUrl}}/pets/1.'),
      headers: { type: 'object', additionalProperties: { type: 'string' } }, body: { description: 'A string, or a JSON value (sent as application/json).' }, project: PROJECT_REF, environment: ENV_REF }, ['method', 'url']),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  run_collection: { title: 'Run a collection', description: 'Runs a project\'s requests (or one folder or feature group) in order with the collection runner and returns pass / fail per request with the reasons.',
    inputSchema: obj({ project: PROJECT_REF, folder: str('Only this folder.'), feature: str('Only this feature group.'), environment: ENV_REF, iterations: { type: 'integer', minimum: 1, maximum: 20 } }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  search: { title: 'Search requests and API specs', description: 'Searches saved requests and every operation of the attached OpenAPI specs (path, summary, operationId, tags, parameters, description).',
    inputSchema: obj({ query: str('Words to look for, e.g. "create order" or "GET /pets".'), limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['query']), annotations: RO },
  get_operation: { title: 'Get an API operation', description: 'One operation of a project\'s attached OpenAPI spec: parameters, request body and responses with their fields.',
    inputSchema: obj({ operation: str('"METHOD /path" as in the spec (e.g. "GET /pets/{petId}") or an operationId.'), project: PROJECT_REF }, ['operation']), annotations: RO },
  history: { title: 'Recent sends', description: 'Recent sends from History (newest first): method, URL, status, time, and the response body (shortened).',
    inputSchema: obj({ request: REQUEST_REF, project: PROJECT_REF, limit: { type: 'integer', minimum: 1, maximum: 50 } }), annotations: RO },
  find_logs: { title: 'Find log lines', description: 'Searches the log lines of the project\'s running tasks and followed log sources (with stack traces) for a text, e.g. a request id or an exception name.',
    inputSchema: obj({ text: str('Text to find (6+ characters), e.g. an X-Request-Id or "NullPointerException".'), project: PROJECT_REF }, ['text']), annotations: RO },
  save_request: { title: 'Save a request', description: 'Creates a request, or updates the one with the same name in that folder. Only offered when "Allow changes" is on in the app\'s Settings.',
    inputSchema: obj({ name: str('Request name.'), project: PROJECT_REF, folder: str('Folder (created if missing). Default: the project root.'), method: { type: 'string' }, url: str('May use {{variables}}.'),
      headers: { type: 'object', additionalProperties: { type: 'string' } }, json: { description: 'A JSON body.' }, body: { type: 'string', description: 'A raw body.' },
      assertions: { type: 'array', items: { type: 'string' }, description: 'JS expressions over status and body, e.g. "status === 200".' } }, ['name', 'url']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, edits: true },
};

const INSTRUCTIONS = 'API Workbench is the user\'s API client. Use list_projects / list_requests / search to find saved requests and API operations, '
  + 'send_request to run one as the app does (auth, variables, scripts), send_http for ad-hoc calls in a project\'s context, run_collection for a folder or feature, '
  + 'and history / find_logs to investigate failures. Credentials are removed from what you see.';

// ---- JSON-RPC / MCP messages

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const listTools = ({ allowEdits }) => Object.entries(TOOLS).filter(([, t]) => !t.edits || allowEdits)
  .map(([name, t]) => ({ name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } }));

// options: { callTool(name, args) → Promise<result value>, allowEdits() → bool }
// → handle(message) → response object | null (for notifications)
function createRpcHandler({ callTool, allowEdits = () => false }) {
  return async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return msg && 'id' in msg && !('result' in msg || 'error' in msg) ? rpcError(msg.id, -32600, 'Invalid request') : null;
    }
    const isNotification = !('id' in msg);
    const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return reply({ protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'api-workbench', title: 'API Workbench', version: '1.0.0' }, instructions: INSTRUCTIONS });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: listTools({ allowEdits: allowEdits() }) });
      case 'tools/call': {
        const name = msg.params?.name, args = msg.params?.arguments || {};
        const tool = TOOLS[name];
        if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        if (tool.edits && !allowEdits()) return reply({ content: [{ type: 'text', text: `${name} is turned off: allow changes in API Workbench → Settings → MCP server first.` }], isError: true });
        try {
          const value = await callTool(name, args);
          return reply({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(value && typeof value === 'object' && !Array.isArray(value) && { structuredContent: value }) });
        } catch (err) {
          return reply({ content: [{ type: 'text', text: String(err?.message || err) }], isError: true });
        }
      }
      default:
        if (isNotification) return null; // notifications/initialized, notifications/cancelled …
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  };
}

// ---- Streamable HTTP transport

// Requests from a browser page carry an Origin; only the app's own (none, or a local one) is accepted, and the
// Host must be the loopback address this server listens on.
function allowedHost(host, port) { return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(String(host || '').toLowerCase()); }
function allowedOrigin(origin) { return !origin || origin === 'null' || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin); }
const sameToken = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// options: { port, token, handle (createRpcHandler), onActivity?(info) } → { listen() → port, close() }
function createMcpServer({ port = 0, token, handle, onActivity = () => {} }) {
  const server = http.createServer((req, res) => {
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    const actual = server.address()?.port;
    if (!allowedHost(req.headers.host, actual) || !allowedOrigin(req.headers.origin)) return send(403, rpcError(null, -32000, 'Forbidden'));
    if (!req.url.startsWith('/mcp')) return send(404, rpcError(null, -32000, 'Not found: the MCP endpoint is /mcp'));
    const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    if (!auth || !sameToken(auth, token)) return send(401, rpcError(null, -32001, 'Unauthorized: use the token from API Workbench → Settings → MCP server'), { 'WWW-Authenticate': 'Bearer' });
    if (req.method === 'DELETE') return send(200); // ending a session: nothing is kept per session
    if (req.method !== 'POST') return send(405, rpcError(null, -32000, 'Method not allowed: POST JSON-RPC messages to /mcp'), { Allow: 'POST, DELETE' });
    let size = 0; const chunks = [];
    req.on('data', (d) => { size += d.length; if (size > MAX_BODY) req.destroy(); else chunks.push(d); });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, rpcError(null, -32700, 'Parse error')); }
      const batch = Array.isArray(msg);
      const out = (await Promise.all((batch ? msg : [msg]).map(handle))).filter(Boolean);
      onActivity({ client: req.headers['user-agent'] || '', at: Date.now(), method: batch ? 'batch' : msg?.method });
      const session = msg?.method === 'initialize' ? { 'Mcp-Session-Id': crypto.randomUUID() } : {};
      if (!out.length) return send(202, undefined, session);
      send(200, batch ? out : out[0], session);
    });
  });
  return {
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address().port)); }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---- Electron wiring: the server's lifetime, and tool calls answered by the app window

let running = null; // { server, port, token, allowEdits, lastActivity }
const pending = new Map(); // call id → { resolve, reject, timer }

function infoFile() { return path.join(require('electron').app.getPath('userData'), 'mcp.json'); }

function callInWindow(name, args) {
  const { windows, alive } = require('./windows');
  const win = alive(windows.main);
  if (!win) return Promise.reject(new Error('The API Workbench window is closed'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name} took longer than 3 minutes`)); }, 180000);
    pending.set(id, { resolve, reject, timer });
    win.webContents.send('mcp-call', { id, name, args });
  });
}

async function start({ port = 3920, token, allowEdits = false }) {
  await stop();
  if (!token || String(token).length < 24) throw new Error('A token of at least 24 characters is needed');
  const handle = createRpcHandler({ callTool: callInWindow, allowEdits: () => !!running?.allowEdits });
  const server = createMcpServer({ port, token, handle, onActivity: (a) => { if (running) running.lastActivity = a; } });
  const actual = await server.listen();
  running = { server, port: actual, token, allowEdits, lastActivity: null };
  // For bin/api-workbench-mcp.js (stdio clients such as Claude Desktop).
  try { fs.writeFileSync(infoFile(), JSON.stringify({ url: `http://127.0.0.1:${actual}/mcp`, port: actual, token }), { mode: 0o600 }); } catch { /* the bridge then can't find it */ }
  return status();
}
async function stop() {
  if (!running) return status();
  await running.server.close();
  running = null;
  try { fs.rmSync(infoFile(), { force: true }); } catch { /* already gone */ }
  return status();
}
const status = () => (running ? { running: true, port: running.port, url: `http://127.0.0.1:${running.port}/mcp`, allowEdits: running.allowEdits, lastActivity: running.lastActivity } : { running: false });

// Started with --mcp (npm run start:mcp) or API_WORKBENCH_MCP=1: the person launching the app asked for the
// MCP server, so it's switched on (and stays on) without going through Settings. Asked for once.
let launchAsked = process.argv.includes('--mcp') || process.env.API_WORKBENCH_MCP === '1';

function register(ipcMain) {
  ipcMain.handle('mcp-launch-request', () => { const asked = launchAsked; launchAsked = false; return asked; });
  ipcMain.handle('mcp-start', async (_e, opts) => { try { return { ok: true, ...(await start(opts)) }; } catch (err) { return { ok: false, error: err.code === 'EADDRINUSE' ? `Port ${opts?.port} is already in use` : err.message }; } });
  ipcMain.handle('mcp-stop', async () => ({ ok: true, ...(await stop()) }));
  ipcMain.handle('mcp-status', () => status());
  ipcMain.handle('mcp-allow-edits', (_e, on) => { if (running) running.allowEdits = !!on; return status(); });
  ipcMain.handle('mcp-result', (_e, { id, ok, value, error }) => {
    const p = pending.get(id); if (!p) return false;
    pending.delete(id); clearTimeout(p.timer);
    if (ok) p.resolve(value); else p.reject(new Error(error || 'Tool failed'));
    return true;
  });
  require('electron').app.on('before-quit', () => { try { fs.rmSync(infoFile(), { force: true }); } catch { /* gone */ } });
}

module.exports = { TOOLS, PROTOCOL_VERSIONS, createRpcHandler, createMcpServer, listTools, register };
