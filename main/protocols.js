'use strict';
// Other protocols, from the main process like normal sends (no browser Origin / fingerprint, and the
// environment's network settings apply): WebSocket (ws), Server-Sent Events, and gRPC (unary and
// streaming, from .proto files). GraphQL is plain HTTP and goes through main/http.js.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { agentFor, tlsOptions } = require('./network');

let emit = () => {}; // (channel, payload) → renderer; set by register()

// ── WebSocket ─────────────────────────────────────────────────────────────────────────────────────
const sockets = new Map(); // id → WebSocket

function wsConnect({ id, url, headers = {}, network = null, protocols = [] }) {
  const WebSocket = require('ws');
  const target = new URL(url);
  const opts = { headers, handshakeTimeout: 15000, perMessageDeflate: true };
  if (target.protocol === 'wss:') Object.assign(opts, tlsOptions(network || {}), network?.proxy ? { agent: agentFor('https:', network) } : {});
  const ws = new WebSocket(url, protocols.length ? protocols : undefined, opts);
  sockets.set(id, ws);
  const t0 = Date.now();
  const send = (type, extra = {}) => emit('ws-event', { id, type, at: Date.now(), ...extra });
  ws.on('upgrade', (res) => send('handshake', { status: res.statusCode, headers: flat(res.headers) }));
  ws.on('open', () => send('open', { protocol: ws.protocol, ms: Date.now() - t0 }));
  ws.on('message', (data, isBinary) => send('message', isBinary ? { binary: true, data: Buffer.from(data).toString('base64'), size: data.length } : { data: data.toString('utf8'), size: data.length }));
  ws.on('unexpected-response', (_req, res) => {
    let body = ''; res.on('data', (c) => { if (body.length < 4096) body += c; });
    res.on('end', () => { send('error', { message: `Server answered HTTP ${res.statusCode} instead of switching protocols`, status: res.statusCode, headers: flat(res.headers), body }); ws.terminate(); });
  });
  ws.on('error', (err) => send('error', { message: err.message }));
  ws.on('close', (code, reason) => { sockets.delete(id); send('close', { code, reason: reason.toString() }); });
  ws.on('ping', () => send('ping'));
  return {};
}

function wsSend({ id, data, binary = false }) {
  const ws = sockets.get(id);
  if (!ws || ws.readyState !== 1) throw new Error('Not connected');
  ws.send(binary ? Buffer.from(data, 'base64') : data);
  return {};
}

function wsClose({ id, code = 1000, reason = '' }) {
  const ws = sockets.get(id); if (!ws) return { closed: false };
  if (ws.readyState === 0) ws.terminate(); else ws.close(code, reason);
  return { closed: true };
}

const flat = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]));

// ── Server-Sent Events ───────────────────────────────────────────────────────────────────────────
const streams = new Map(); // id → ClientRequest

// Feeds text chunks, calls onEvent({ event, data, lastEventId, retry }) per complete event (per the SSE spec).
function sseParser(onEvent) {
  let buf = '', data = [], event = '', lastId, retry;
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + (buf.startsWith('\r\n', nl) ? 2 : 1));
      if (line === '') {
        if (data.length) onEvent({ event: event || 'message', data: data.join('\n'), lastEventId: lastId, retry });
        data = []; event = ''; retry = undefined;
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive
      const at = line.indexOf(':');
      const field = at < 0 ? line : line.slice(0, at);
      const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id') lastId = value;
      else if (field === 'retry' && /^\d+$/.test(value)) retry = +value;
    }
  };
}

function sseStart({ id, url, headers = {}, network = null, method = 'GET', body }) {
  const target = new URL(url);
  const lib = target.protocol === 'https:' ? https : http;
  const send = (type, extra = {}) => emit('sse-event', { id, type, at: Date.now(), ...extra });
  const t0 = Date.now();
  const req = lib.request(target, { method, headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', ...headers }, agent: agentFor(target.protocol, network) }, (res) => {
    send('open', { status: res.statusCode, statusText: res.statusMessage, headers: flat(res.headers), ms: Date.now() - t0 });
    res.setEncoding('utf8');
    if (res.statusCode >= 300 || !/text\/event-stream/i.test(res.headers['content-type'] || '')) {
      let text = ''; res.on('data', (c) => { if (text.length < 8192) text += c; });
      res.on('end', () => { streams.delete(id); send('error', { message: `HTTP ${res.statusCode}${/event-stream/.test(res.headers['content-type'] || '') ? '' : ` (${res.headers['content-type'] || 'no content type'}, not an event stream)`}`, body: text }); send('close'); });
      return;
    }
    const parse = sseParser((e) => send('message', e));
    res.on('data', parse);
    res.on('end', () => { streams.delete(id); send('close'); });
    res.on('error', (err) => { if (!req.stopped) send('error', { message: err.message }); });
  });
  req.on('error', (err) => { if (req.stopped) return; send('error', { message: err.message }); streams.delete(id); send('close'); });
  streams.set(id, req);
  req.end(body);
  return {};
}

function sseStop({ id }) {
  const req = streams.get(id); if (!req) return { stopped: false };
  req.stopped = true; req.destroy(); streams.delete(id);
  emit('sse-event', { id, type: 'close', at: Date.now(), stopped: true });
  return { stopped: true };
}

// ── gRPC ─────────────────────────────────────────────────────────────────────────────────────────
const protoCache = new Map(); // key → { mtimeMs, def }

function loadProto(protoFile, includeDirs = []) {
  const protoLoader = require('@grpc/proto-loader');
  if (!protoFile) throw new Error('Choose a .proto file (Proto tab)');
  const st = fs.statSync(protoFile);
  const key = protoFile + '|' + includeDirs.join('|');
  const hit = protoCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.def;
  const def = protoLoader.loadSync(protoFile, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [path.dirname(protoFile), ...includeDirs] });
  protoCache.set(key, { mtimeMs: st.mtimeMs, def });
  return def;
}

const isService = (v) => v && typeof v === 'object' && !v.format && Object.values(v).every((m) => m && typeof m.path === 'string');

// A JSON template for a message type (from proto-loader's DescriptorProto).
const SCALAR = { TYPE_STRING: '', TYPE_BYTES: '', TYPE_BOOL: false, TYPE_DOUBLE: 0, TYPE_FLOAT: 0, TYPE_INT32: 0, TYPE_UINT32: 0, TYPE_SINT32: 0, TYPE_FIXED32: 0, TYPE_SFIXED32: 0, TYPE_INT64: '0', TYPE_UINT64: '0', TYPE_SINT64: '0', TYPE_FIXED64: '0', TYPE_SFIXED64: '0' };
function template(def, type, depth = 0) {
  if (!type || depth > 6) return {};
  const out = {};
  for (const f of type.field || []) {
    let v;
    if (f.type === 'TYPE_MESSAGE') {
      const ref = def[f.typeName.replace(/^\./, '')];
      const nested = ref?.type;
      // map<k, v> fields are repeated *Entry messages.
      if (nested?.options?.mapEntry) { out[f.name] = {}; continue; }
      v = template(def, nested, depth + 1);
    } else if (f.type === 'TYPE_ENUM') v = def[f.typeName.replace(/^\./, '')]?.type?.value?.[0]?.name ?? 0;
    else v = SCALAR[f.type] ?? null;
    out[f.name] = f.label === 'LABEL_REPEATED' ? [v] : v;
  }
  return out;
}

function grpcDescribe({ protoFile, includeDirs = [] }) {
  const def = loadProto(protoFile, includeDirs);
  const services = Object.entries(def).filter(([, v]) => isService(v)).map(([name, methods]) => ({
    name,
    methods: Object.entries(methods).map(([m, d]) => ({
      name: m, path: d.path, requestStream: d.requestStream, responseStream: d.responseStream,
      requestType: d.requestType?.type?.name, responseType: d.responseType?.type?.name,
      template: JSON.stringify(template(def, d.requestType?.type), null, 2),
    })),
  }));
  return { services };
}

// gRPC status → the nearest HTTP status (as grpc-gateway maps them), so assertions, the runner and
// colours treat failures as failures.
const GRPC_HTTP = [200, 499, 500, 400, 504, 404, 409, 403, 429, 400, 409, 400, 501, 500, 503, 500, 401];
const calls = new Map(); // id → call

function grpcCall({ id, url, headers = {}, body, grpc: g = {}, network = null, timeoutMs = 0 }) {
  const grpc = require('@grpc/grpc-js');
  const def = loadProto(g.protoFile, g.includeDirs || []);
  const service = def[g.service];
  if (!isService(service)) throw new Error(`Service ${g.service || '(none)'} isn't in ${path.basename(g.protoFile)}`);
  const method = service[g.method];
  if (!method) throw new Error(`Method ${g.method || '(none)'} isn't in ${g.service}`);
  const target = /^grpcs?:\/\//i.test(url) ? new URL(url) : new URL('grpc://' + url.replace(/^\w+:\/\//, ''));
  const secure = target.protocol === 'grpcs:';
  const address = `${target.hostname}:${target.port || (secure ? 443 : 80)}`;
  let creds = grpc.credentials.createInsecure();
  if (secure) {
    const t = tlsOptions(network || {});
    const verify = network?.insecure ? { checkServerIdentity: () => undefined, rejectUnauthorized: false } : {};
    creds = grpc.credentials.createSsl(network?.caFile ? Buffer.from([].concat(t.ca).join('\n')) : null, t.key || null, t.cert || null, verify);
  }
  const Client = grpc.makeGenericClientConstructor(service, g.service);
  const client = new Client(address, creds);
  const md = new grpc.Metadata();
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (/^(host|content-type|content-length|te|user-agent|connection)$/.test(key) || key.startsWith(':')) continue;
    if (key.endsWith('-bin')) md.add(key, Buffer.from(String(v), 'base64')); else md.add(key, String(v));
  }
  let input;
  try { input = body?.trim() ? JSON.parse(body) : {}; } catch (err) { throw new Error('The message must be JSON: ' + err.message); }
  const options = timeoutMs ? { deadline: Date.now() + timeoutMs } : {};
  const t0 = performance.now();
  return new Promise((resolve) => {
    const messages = [];
    let responseMeta = {};
    const finish = (status) => {
      calls.delete(id); client.close();
      const code = status?.code ?? 0;
      const name = Object.keys(grpc.status).find((k) => grpc.status[k] === code) || String(code);
      const trailers = status?.metadata ? flat(status.metadata.getMap()) : {};
      const single = !method.responseStream;
      resolve({
        ok: true, status: GRPC_HTTP[code] ?? 500, statusText: `${name}${code ? ` (gRPC ${code}): ${status.details || ''}` : ''}`, grpcCode: code,
        headers: { ...responseMeta, 'content-type': 'application/json', 'grpc-status': String(code), ...(status?.details && { 'grpc-message': status.details }), ...trailers },
        body: messages.length || !code ? JSON.stringify(single ? messages[0] ?? {} : messages, null, 2) : '',
        timing: (() => { const ms = Math.round(performance.now() - t0); return { dns: 0, tcp: 0, tls: 0, request: 0, wait: ms, download: 0, total: ms, overall: ms }; })(), url: `${secure ? 'grpcs' : 'grpc'}://${address}/${method.path.replace(/^\//, '')}`,
        sentHeaders: { ...flat(md.getMap()), ':path': method.path },
      });
    };
    let call;
    const onMeta = (m) => { responseMeta = flat(m.getMap()); };
    if (!method.requestStream && !method.responseStream) {
      call = client[g.method](input, md, options, (err, msg) => { if (msg) messages.push(msg); if (err) finish(err); });
      call.on('status', (s) => { if (s.code === 0) finish(s); });
    } else {
      const inputs = method.requestStream ? (Array.isArray(input) ? input : [input]) : null;
      call = method.requestStream
        ? (method.responseStream ? client[g.method](md, options) : client[g.method](md, options, (err, msg) => { if (msg) messages.push(msg); if (err) finish(err); }))
        : client[g.method](input, md, options);
      call.on('data', (m) => messages.push(m));
      call.on('error', (err) => finish(err));
      call.on('status', (s) => { if (s.code === 0) finish(s); });
      if (inputs) { for (const m of inputs) call.write(m); call.end(); }
    }
    call.on('metadata', onMeta);
    calls.set(id, call);
  });
}

function grpcCancel({ id }) { calls.get(id)?.cancel(); return {}; }

function register(ipcMain) {
  const { windows, alive } = require('./windows');
  emit = (ch, payload) => alive(windows.main)?.webContents.send(ch, payload);
  const guard = (fn) => async (_e, arg) => { try { return { ok: true, ...(await fn(arg)) }; } catch (err) { return { ok: false, error: err.message }; } };
  ipcMain.handle('ws-connect', guard(wsConnect));
  ipcMain.handle('ws-send', guard(wsSend));
  ipcMain.handle('ws-close', guard(wsClose));
  ipcMain.handle('sse-start', guard(sseStart));
  ipcMain.handle('sse-stop', guard(sseStop));
  ipcMain.handle('grpc-describe', guard(grpcDescribe));
  ipcMain.handle('grpc-call', async (_e, arg) => { try { return await grpcCall(arg); } catch (err) { return { ok: false, error: err.message }; } });
  ipcMain.handle('grpc-cancel', guard(grpcCancel));
}

// For tests: route events somewhere else.
const setEmitter = (fn) => { emit = fn; };

module.exports = { wsConnect, wsSend, wsClose, sseStart, sseStop, sseParser, grpcDescribe, grpcCall, template, setEmitter, register };
