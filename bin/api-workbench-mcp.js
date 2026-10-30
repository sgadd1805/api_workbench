#!/usr/bin/env node
'use strict';
// stdio ⇄ API Workbench's MCP server, for MCP clients that start a local command (Claude Desktop):
//   { "mcpServers": { "api-workbench": { "command": "node", "args": ["<app folder>/bin/api-workbench-mcp.js"] } } }
// Each JSON-RPC line on stdin is POSTed to the running app's MCP endpoint, and its answer written to stdout.
// The endpoint and token come from <user data>/mcp.json, which the app writes while its MCP server is on
// (Settings → MCP server), so nothing secret goes in the client's config. Options: --data <user data folder>
// (or API_WORKBENCH_DATA). Only JSON-RPC goes to stdout; anything else goes to stderr.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');

function dataDir(argv = process.argv.slice(2), env = process.env, platform = process.platform) {
  const i = argv.indexOf('--data');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (env.API_WORKBENCH_DATA) return env.API_WORKBENCH_DATA;
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'api-workbench');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'api-workbench');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'api-workbench');
}

const NOT_RUNNING = 'API Workbench isn\'t running, or its MCP server is off: open the app and turn it on in Settings → MCP server.';

// Read for every message: the app may have restarted on another port or with a new token.
function endpoint(dir) {
  try { const info = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8')); return info?.url && info.token ? info : null; } catch { return null; }
}

// One message to the app. → { status, body, session }
function post(info, text, session) {
  return new Promise((resolve, reject) => {
    const u = new URL(info.url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: 200000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${info.token}`, 'Content-Length': Buffer.byteLength(text), ...(session && { 'Mcp-Session-Id': session }) } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), session: res.headers['mcp-session-id'] }));
    });
    req.on('timeout', () => req.destroy(new Error('API Workbench took too long to answer')));
    req.on('error', reject);
    req.end(text);
  });
}

function main({ input = process.stdin, output = process.stdout, dir = dataDir() } = {}) {
  let session = null, queue = Promise.resolve();
  const write = (msg) => output.write(JSON.stringify(msg) + '\n');
  const fail = (msg, message) => { for (const m of [].concat(msg)) if (m && 'id' in m && 'method' in m) write({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message } }); };
  const handle = async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const info = endpoint(dir);
    if (!info) return fail(msg, NOT_RUNNING);
    try {
      const res = await post(info, line, session);
      if (res.session) session = res.session;
      if (res.status === 202 || !res.body) return;
      if (res.status === 401) return fail(msg, 'API Workbench refused the token: turn its MCP server off and on, or restart this client.');
      const answer = JSON.parse(res.body);
      for (const a of [].concat(answer)) write(a);
    } catch (err) {
      fail(msg, err.code === 'ECONNREFUSED' ? NOT_RUNNING : `API Workbench: ${err.message}`);
    }
  };
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => { queue = queue.then(() => handle(line)); }); // in order, one at a time
  return new Promise((resolve) => rl.on('close', () => queue.then(resolve)));
}

if (require.main === module) main().then(() => process.exit(0));
module.exports = { main, dataDir, endpoint };
