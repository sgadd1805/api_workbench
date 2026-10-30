// The MCP server: protocol (main/mcp.js), HTTP transport and its checks, the stdio bridge
// (bin/api-workbench-mcp.js), and the tools (renderer/app/mcp.js) against a real local API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { nodeApi } = await import('../cli/node-api.mjs'); // installs window.electronAPI (sends go through main/http.js)
globalThis.localStorage = { getItem: () => null, setItem() {} };
const { createRpcHandler, createMcpServer, TOOLS } = require('../main/mcp.js');
const bridge = require('../bin/api-workbench-mcp.js');
const { DB, S, normalizeDB } = await import('../renderer/app/store.js');
const { applyConfig } = await import('../renderer/app/config.js');
const { callTool, MCP_TOOLS } = await import('../renderer/app/mcp.js');

let api, base;
before(async () => {
  api = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
      const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=COOKIE-1' }); res.end(JSON.stringify(o)); };
      if (req.url.startsWith('/login')) return json(200, { access_token: 'tok_LIVE_123', user: 'bo' });
      if (req.url === '/pets/1') return req.headers.authorization === 'Bearer SECRET-TOKEN-9' ? json(200, { id: 1, name: 'Rex' }) : json(401, { error: 'no' });
      if (req.url === '/echo') return json(200, { got: JSON.parse(body || 'null'), auth: req.headers.authorization || null });
      json(404, { error: 'not found' });
    });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
});
after(() => api.close());

function setup({ redact = true, allowEdits = false } = {}) {
  Object.assign(DB, { projects: [], features: [], notes: [], tokenSources: [], settings: { mcp: { redact, allowEdits } } }); normalizeDB(DB);
  const p = applyConfig({ project: { name: 'Shop', auth: { type: 'bearer', token: '{{token}}' } },
    environments: [{ name: 'local', active: true, variables: { baseUrl: base, token: { secret: true } } }, { name: 'staging', variables: { baseUrl: 'http://staging.invalid' } }],
    folders: [{ name: 'Pets', requests: [{ name: 'Get pet', url: '{{baseUrl}}/pets/1', assertions: ['status === 200', 'body.name === "Rex"'] }, { name: 'Missing', url: '{{baseUrl}}/nope', assertions: ['status === 200'] }] },
      { name: 'Auth', auth: 'none', requests: [{ name: 'Log in', method: 'POST', url: '{{baseUrl}}/login?api_key=KEY-77777777', json: { user: 'bo', password: 'hunter2-SECRET' } }] }] }).project;
  p.envs[0].vars.find((v) => v.k === 'token').v = 'SECRET-TOKEN-9';
  S.projectId = p.id;
  return p;
}

test('protocol: initialize, tools/list, tools/call, errors, notifications', async () => {
  let edits = false;
  const handle = createRpcHandler({ callTool: async (name, args) => (name === 'search' ? { echo: args.query } : Promise.reject(new Error('boom'))), allowEdits: () => edits });
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't' } } });
  assert.deepEqual([init.result.protocolVersion, init.result.serverInfo.name, !!init.result.capabilities.tools], ['2025-03-26', 'api-workbench', true]);
  assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).result.protocolVersion, '2025-06-18');
  const names = (await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools.map((t) => t.name);
  assert.ok(names.includes('send_request') && !names.includes('save_request'), 'save_request only with "Allow changes"');
  edits = true;
  assert.ok((await handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).result.tools.some((t) => t.name === 'save_request'));
  const ok = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search', arguments: { query: 'pets' } } });
  assert.deepEqual([JSON.parse(ok.result.content[0].text), ok.result.structuredContent, ok.result.isError], [{ echo: 'pets' }, { echo: 'pets' }, undefined]);
  const bad = await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'history', arguments: {} } });
  assert.deepEqual([bad.result.isError, bad.result.content[0].text], [true, 'boom']);
  assert.equal((await handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'rm_rf' } })).error.code, -32602);
  assert.equal((await handle({ jsonrpc: '2.0', id: 8, method: 'resources/list' })).error.code, -32601);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 9, method: 'ping' })).result, {});
  assert.deepEqual(Object.keys(TOOLS).sort(), [...MCP_TOOLS].sort(), 'every listed tool is implemented in the app');
});

test('HTTP transport: token, Host and Origin checks; JSON answers; 202 for notifications; batches', async () => {
  const token = 'x'.repeat(48);
  const server = createMcpServer({ port: 0, token, handle: createRpcHandler({ callTool: async () => ({}) }) });
  const port = await server.listen();
  const call = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
  try {
    const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.status, 200); assert.ok(init.headers.get('mcp-session-id'));
    assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: '' })).status, 401);
    assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).status, 403, 'a web page can\'t call it');
    assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'http://localhost:5173' })).status, 200);
    const rebound = await new Promise((resolve) => http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { Host: `evil.example:${port}`, Authorization: `Bearer ${token}` } }, (r) => resolve(r.statusCode)).end('{}'));
    assert.equal(rebound, 403, 'DNS rebinding: a foreign Host is refused');
    assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
    const batch = await (await call([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 2, method: 'ping' }])).json();
    assert.deepEqual(batch.map((m) => m.id), [1, 2]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{nope' })).status, 400);
  } finally { await server.close(); }
});

test('stdio bridge: lines to the app and back; a clear error when the app is off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-'));
  const token = 'y'.repeat(48);
  const run = async (lines) => {
    const input = new PassThrough(), output = new PassThrough(); let out = '';
    output.on('data', (d) => (out += d));
    const done = bridge.main({ input, output, dir });
    for (const l of lines) input.write(l + '\n');
    input.end(); await done;
    return out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const off = await run(['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}', '{"jsonrpc":"2.0","method":"notifications/initialized"}']);
  assert.equal(off.length, 1); assert.match(off[0].error.message, /isn't running, or its MCP server is off/);
  const server = createMcpServer({ port: 0, token, handle: createRpcHandler({ callTool: async (n, a) => ({ tool: n, a }) }) });
  const port = await server.listen();
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ url: `http://127.0.0.1:${port}/mcp`, port, token }));
  try {
    const out = await run(['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}', '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}', 'not json']);
    assert.deepEqual(out.map((m) => m.id), [1, 2, null]);
    assert.equal(out[0].result.serverInfo.name, 'api-workbench');
    assert.deepEqual(out[1].result.structuredContent, { tool: 'list_projects', a: {} });
    assert.equal(out[2].error.code, -32700);
  } finally { await server.close(); }
  assert.equal(bridge.dataDir(['--data', '/x']), '/x');
  assert.match(bridge.dataDir([], { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32'), /api-workbench$/);
});

test('tools: list, inspect, send saved and ad-hoc requests, run a folder, search, history', async () => {
  const p = setup();
  const projects = await callTool('list_projects');
  assert.deepEqual(projects.projects.map((x) => [x.name, x.requests, x.environments]), [['Shop', 3, ['local (active)', 'staging']]]);
  const list = await callTool('list_requests', { folder: 'pets' });
  assert.deepEqual(list.requests.map((r) => [r.folder, r.name, r.method, r.url]), [['Pets', 'Get pet', 'GET', '{{baseUrl}}/pets/1'], ['Pets', 'Missing', 'GET', '{{baseUrl}}/nope']]);
  const sent = await callTool('send_request', { request: 'Pets/Get pet' });
  assert.deepEqual([sent.status, JSON.parse(sent.body), sent.assertions.every((a) => a.passed)], [200, { id: 1, name: 'Rex' }, true]);
  assert.equal(sent.headers['Set-Cookie'] ?? sent.headers['set-cookie'], '[redacted]');
  await assert.rejects(callTool('send_request', { request: 'Nope' }), /No request "Nope" in Shop/);
  await assert.rejects(callTool('send_request', { request: 'Get pet', environment: 'prod' }), /No environment "prod"/);
  const adhoc = await callTool('send_http', { method: 'POST', url: '{{baseUrl}}/echo', body: { a: 1 } });
  assert.deepEqual(JSON.parse(adhoc.body), { got: { a: 1 }, auth: 'Bearer [redacted]' }, 'the project\'s auth was applied, and hidden');
  const run = await callTool('run_collection', { folder: 'Pets' });
  assert.deepEqual([run.passed, run.failed, run.results.map((r) => r.passed)], [1, 1, [true, false]]);
  assert.match(run.results[1].failures.join(' '), /status === 200/);
  assert.ok((await callTool('search', { query: 'pet' })).results.some((r) => r.kind === 'request' && r.name === 'Get pet'));
  assert.ok((await callTool('history', { request: 'Get pet' })).sends.length >= 2);
  const envs = await callTool('list_environments');
  assert.deepEqual(envs.environments[0].variables, { baseUrl: base, token: '[secret]' });
  assert.equal(p.name, 'Shop');
});

test('tools: credentials hidden by default; shown only when the user turns hiding off', async () => {
  setup();
  const login = await callTool('send_request', { request: 'Auth/Log in' });
  const all = JSON.stringify(login) + JSON.stringify(await callTool('get_request', { request: 'Log in' })) + JSON.stringify(await callTool('history', {}));
  for (const s of ['tok_LIVE_123', 'KEY-77777777', 'hunter2-SECRET', 'SECRET-TOKEN-9', 'COOKIE-1']) assert.ok(!all.includes(s), s);
  setup({ redact: false });
  const open = await callTool('send_request', { request: 'Auth/Log in' });
  assert.ok(open.body?.includes('tok_LIVE_123'), JSON.stringify(open).slice(0, 300));
});

test('tools: save_request creates and updates by name; logs search needs 6+ characters', async () => {
  const p = setup({ allowEdits: true });
  const made = await callTool('save_request', { name: 'Echo', folder: 'Tools', method: 'POST', url: '{{baseUrl}}/echo', json: { x: 1 }, assertions: ['status === 200'] });
  assert.deepEqual([made.saved, made.created], ['Tools/Echo', true]);
  const again = await callTool('save_request', { name: 'Echo', folder: 'Tools', url: '{{baseUrl}}/echo?v=2' });
  assert.deepEqual([again.created, p.folders.find((f) => f.name === 'Tools').requests.length], [false, 1]);
  nodeApi.logsFind = async (ids, needles) => [{ name: 'pets-service', lines: [{ text: `ERROR ${needles[0]} failed, token=abc12345` }] }];
  const logs = await callTool('find_logs', { text: 'req-123456' });
  assert.deepEqual(logs.sources[0].lines, ['ERROR req-123456 failed, token=[redacted]']);
  await assert.rejects(callTool('find_logs', { text: 'abc' }), /at least 6 characters/);
});
