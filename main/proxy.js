'use strict';
// Intercepting HTTP(S) proxy. Other apps (a frontend, a mobile app, a Java service) are pointed at it
// and each exchange is reported to the app (Proxy page + History). With "decrypt HTTPS", CONNECT
// tunnels are terminated with a leaf certificate from the local CA (main/proxyca.js); otherwise they're
// passed through untouched and only the host is recorded. Breakpoints pause matching requests until the
// user forwards (optionally edited) or drops them.
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const path = require('path');
const fs = require('fs');
const { decode, isBinary } = require('./http');

const HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const MAX_RECORDED = 1024 * 1024;     // body bytes kept per side for display
const MAX_BUFFERED = 50 * 1024 * 1024; // request bodies are buffered (for breakpoints) up to this

let seq = 0;
const nextId = () => `px${Date.now().toString(36)}${(++seq).toString(36)}`;

function stripHop(headers) {
  const connection = Object.entries(headers).find(([k]) => k.toLowerCase() === 'connection')?.[1];
  const drop = new Set([...HOP, ...String(connection || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)]);
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())));
}

// A recorded body: text, or base64 for binary types; capped.
function recordBody(buf, headers) {
  if (!buf?.length) return { body: '' };
  let data = buf;
  try { data = decode(buf, headers['content-encoding']); } catch { /* keep as-is */ }
  const truncated = data.length > MAX_RECORDED;
  const slice = truncated ? data.subarray(0, MAX_RECORDED) : data;
  const type = headers['content-type'];
  return isBinary(type)
    ? { body: `(binary ${type}, ${data.length} bytes)`, binary: true, bodyBase64: slice.toString('base64'), size: data.length, truncated }
    : { body: slice.toString('utf8'), size: data.length, truncated };
}

const flat = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]));

// rule: "substring" or "METHOD substring" (case-insensitive), matched against the full URL.
function matchesBreakpoint(rules, method, url) {
  const u = url.toLowerCase();
  return (rules || []).some((rule) => {
    const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.*)$/i.exec(rule.trim());
    const [want, text] = m ? [m[1].toUpperCase(), m[2]] : [null, rule.trim()];
    return text && (!want || want === method) && u.includes(text.toLowerCase());
  });
}

// opts: { port, host ('127.0.0.1' | '0.0.0.0'), decryptHttps, signer (proxyca leafSigner), caPem,
//         insecureUpstream, breakpoints: [rule], onExchange(record), onPause(paused) }
function createProxy(opts) {
  const o = { ...opts };
  const paused = new Map(); // id → resolve(decision)

  function forward(record, { method, url, headers, body }, res) {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const t0 = performance.now();
    const up = lib.request({
      method, hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search, headers, rejectUnauthorized: !o.insecureUpstream,
      servername: net.isIP(target.hostname) ? undefined : target.hostname,
    }, (upRes) => {
      const chunks = []; let size = 0;
      res.writeHead(upRes.statusCode, upRes.statusMessage, stripHop(upRes.headers));
      upRes.on('data', (c) => { res.write(c); if (size < MAX_RECORDED * 4) { chunks.push(c); size += c.length; } });
      upRes.on('end', () => {
        res.end();
        const rh = flat(upRes.headers);
        o.onExchange({ ...record, status: upRes.statusCode, statusText: upRes.statusMessage || '', responseHeaders: rh, response: recordBody(Buffer.concat(chunks), rh), time: Math.round(performance.now() - t0) });
      });
      upRes.on('error', (err) => { res.destroy(err); o.onExchange({ ...record, error: err.message, time: Math.round(performance.now() - t0) }); });
    });
    up.on('error', (err) => {
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(`API Workbench proxy: ${err.message}`); } else res.destroy();
      o.onExchange({ ...record, error: err.message, time: Math.round(performance.now() - t0) });
    });
    up.end(body?.length ? body : undefined);
  }

  // A request arriving at the proxy (plain HTTP, or decrypted from a CONNECT tunnel when secure).
  function handle(req, res, secureHost) {
    // Requests for the proxy itself: a help page and the CA certificate (for phones: browse to http://<ip>:<port>/ca.crt).
    if (!secureHost && !/^https?:\/\//i.test(req.url)) {
      if (req.url === '/ca.crt' && o.caPem) { res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="api-workbench-proxy-ca.crt"' }); return res.end(o.caPem); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<h1>API Workbench proxy</h1><p>Set this address as the HTTP/HTTPS proxy.${o.caPem ? ' To decrypt HTTPS, trust <a href="/ca.crt">this CA certificate</a> on the device.' : ''}</p>`);
    }
    const url = secureHost ? `https://${req.headers.host || secureHost}${req.url}` : req.url;
    const chunks = []; let size = 0, tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_BUFFERED) tooBig = true; else chunks.push(c); });
    req.on('end', async () => {
      if (tooBig) { res.writeHead(413); return res.end('API Workbench proxy: request body too large to record'); }
      const headers = stripHop(req.headers), body = Buffer.concat(chunks);
      const record = { id: nextId(), at: Date.now(), method: req.method, url, client: req.socket.remoteAddress, requestHeaders: flat(headers), request: recordBody(body, flat(headers)) };
      let out = { method: req.method, url, headers, body };
      if (matchesBreakpoint(o.breakpoints, req.method, url)) {
        const decision = await new Promise((resolve) => {
          paused.set(record.id, resolve);
          o.onPause({ id: record.id, at: record.at, method: req.method, url, headers: flat(headers), body: record.request.binary ? null : body.toString('utf8') });
        });
        paused.delete(record.id);
        if (decision.action === 'drop') {
          res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Dropped at a breakpoint in API Workbench');
          return o.onExchange({ ...record, error: 'Dropped at breakpoint' });
        }
        if (decision.request) {
          const e = decision.request;
          const newBody = e.body != null ? Buffer.from(e.body, 'utf8') : body;
          const h = { ...e.headers };
          // Keep Content-Length honest after an edit.
          for (const k of Object.keys(h)) if (k.toLowerCase() === 'content-length') delete h[k];
          if (newBody.length) h['content-length'] = String(newBody.length);
          out = { method: e.method || req.method, url: e.url || url, headers: h, body: newBody };
          Object.assign(record, { method: out.method, url: out.url, requestHeaders: flat(h), request: recordBody(newBody, flat(h)), edited: true });
        }
      }
      forward(record, out, res);
    });
  }

  // WebSocket and other upgrades: piped through, recorded as one line.
  function upgrade(req, socket, head, secureHost) {
    const url = secureHost ? `wss://${req.headers.host || secureHost}${req.url}` : req.url.replace(/^http/, 'ws');
    let target; try { target = new URL(url); } catch { return socket.destroy(); }
    const secure = target.protocol === 'wss:';
    const port = +target.port || (secure ? 443 : 80);
    const up = secure ? tls.connect({ host: target.hostname, port, servername: net.isIP(target.hostname) ? undefined : target.hostname, rejectUnauthorized: !o.insecureUpstream }) : net.connect(port, target.hostname);
    up.on(secure ? 'secureConnect' : 'connect', () => {
      const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`, ...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`)];
      up.write(lines.join('\r\n') + '\r\n\r\n'); if (head?.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
      o.onExchange({ id: nextId(), at: Date.now(), method: req.method, url, requestHeaders: flat(req.headers), request: { body: '' }, status: 101, statusText: 'Switching Protocols (piped, frames not recorded)', responseHeaders: {}, response: { body: '' }, time: 0 });
    });
    track(up);
    const fail = () => { socket.destroy(); up.destroy(); };
    up.on('error', fail); socket.on('error', fail);
  }

  const decrypted = http.createServer((req, res) => handle(req, res, req.socket.proxyTarget));
  decrypted.on('upgrade', (req, socket, head) => upgrade(req, socket, head, socket.proxyTarget));
  decrypted.on('clientError', (_e, socket) => socket.destroy());

  const server = http.createServer((req, res) => handle(req, res, null));
  // Tunnels and upgraded sockets aren't tracked by closeAllConnections; close() destroys them too.
  const sockets = new Set();
  const track = (s) => { sockets.add(s); s.once('close', () => sockets.delete(s)); };
  server.on('connection', track);
  server.on('upgrade', (req, socket, head) => upgrade(req, socket, head, null));
  server.on('clientError', (_e, socket) => socket.destroy());
  server.on('connect', (req, socket, head) => {
    const [host, portText] = req.url.split(/:(?=\d+$)/);
    const port = +portText || 443;
    socket.on('error', () => {});
    if (o.decryptHttps && o.signer) {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) socket.unshift(head);
      const tlsSocket = new tls.TLSSocket(socket, {
        isServer: true, ALPNProtocols: ['http/1.1'],
        secureContext: o.signer.contextFor(host),
        SNICallback: (name, cb) => { try { cb(null, o.signer.contextFor(name || host)); } catch (err) { cb(err); } },
      });
      tlsSocket.proxyTarget = port === 443 ? host : `${host}:${port}`;
      tlsSocket.on('error', (err) => o.onExchange({ id: nextId(), at: Date.now(), method: 'CONNECT', url: `https://${req.url}`, requestHeaders: {}, request: { body: '' }, error: `TLS: ${err.message} (does the client trust the proxy's CA?)`, time: 0 }));
      decrypted.emit('connection', tlsSocket);
      return;
    }
    // Pass-through tunnel.
    const t0 = performance.now();
    const up = net.connect(port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
      o.onExchange({ id: nextId(), at: Date.now(), method: 'CONNECT', url: `https://${req.url}`, requestHeaders: flat(req.headers), request: { body: '' }, status: 200, statusText: 'Tunnel (not decrypted)', responseHeaders: {}, response: { body: '' }, time: Math.round(performance.now() - t0), tunnel: true });
    });
    track(up);
    up.on('error', (err) => { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); o.onExchange({ id: nextId(), at: Date.now(), method: 'CONNECT', url: `https://${req.url}`, requestHeaders: {}, request: { body: '' }, error: err.message, time: 0 }); });
  });

  return {
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(o.port || 0, o.host || '127.0.0.1', () => resolve(server.address().port)); }),
    close: () => {
      for (const resolve of paused.values()) resolve({ action: 'drop' });
      paused.clear();
      server.closeAllConnections?.(); decrypted.closeAllConnections?.();
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
    update: (patch) => Object.assign(o, patch),
    resume: (id, decision) => { const r = paused.get(id); if (r) r(decision); return !!r; },
    pausedIds: () => [...paused.keys()],
  };
}

// ---- Electron wiring
let proxy = null, ca = null;

// The CA key (proxy-ca/ca.key, readable by your user account only) is sealed with the operating system's
// protection when encryption is on (main/vault.js): "sealed:" + ciphertext. Otherwise it's plain PEM.
const caDir = () => path.join(require('electron').app.getPath('userData'), 'proxy-ca');
async function vaultSeal(pem) { const v = require('./vault'); await v.ready(); return v.active() ? 'sealed:' + await v.encrypt(pem) : pem; }
const vaultUnseal = async (stored) => (stored.startsWith('sealed:') ? require('./vault').decrypt(stored.slice(7)) : stored);

// Rewrites the CA key in the form the encryption setting asks for (after it changed, an older file, or a
// rotated OS key).
async function resealCaKey() {
  const keyFile = path.join(caDir(), 'ca.key');
  try {
    const stored = fs.readFileSync(keyFile, 'utf8');
    const want = await vaultSeal(await vaultUnseal(stored));
    if (stored.startsWith('sealed:') !== want.startsWith('sealed:') || require('./vault').takeRekey()) fs.writeFileSync(keyFile, want, { mode: 0o600 });
  } catch { /* no key yet, or unreadable here: a new CA is made when needed */ }
}

async function ensureCa(regenerate = false) {
  const { loadOrCreateCa, leafSigner, caInfo } = require('./proxyca');
  if (!ca || regenerate) {
    await resealCaKey();
    const loaded = await loadOrCreateCa(caDir(), { regenerate, seal: vaultSeal, unseal: vaultUnseal });
    ca = { ...loaded, signer: leafSigner(loaded), info: caInfo(loaded.certPem) };
  }
  return ca;
}

function register(ipcMain) {
  const { windows, alive } = require('./windows');
  const { shell } = require('electron');
  const send = (ch, payload) => alive(windows.main)?.webContents.send(ch, payload);
  const guard = (fn) => async (_e, arg) => { try { return { ok: true, ...(await fn(arg)) }; } catch (err) { return { ok: false, error: err.code === 'EADDRINUSE' ? `Port ${arg?.port} is already in use` : err.message }; } };
  ipcMain.handle('proxy-start', guard(async ({ port, allowLan, decryptHttps, insecureUpstream, breakpoints }) => {
    if (proxy) await proxy.close();
    const c = decryptHttps ? await ensureCa() : null;
    proxy = createProxy({ port, host: allowLan ? '0.0.0.0' : '127.0.0.1', decryptHttps, signer: c?.signer, caPem: c?.certPem, insecureUpstream, breakpoints,
      onExchange: (x) => send('proxy-exchange', x), onPause: (p) => send('proxy-paused', p) });
    const actual = await proxy.listen();
    const lan = allowLan ? Object.values(require('os').networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address) : [];
    return { port: actual, lan };
  }));
  ipcMain.handle('proxy-stop', guard(async () => { if (proxy) { await proxy.close(); proxy = null; } return {}; }));
  ipcMain.handle('proxy-update', guard((patch) => { proxy?.update(patch); return {}; }));
  ipcMain.handle('proxy-resume', guard(({ id, decision }) => ({ resumed: !!proxy?.resume(id, decision) })));
  ipcMain.handle('proxy-ca', guard(async ({ regenerate = false, peek = false } = {}) => {
    // peek: report the CA only if one exists already (opening the page shouldn't create it).
    if (peek && !ca && !require('fs').existsSync(path.join(caDir(), 'ca.crt'))) return { none: true };
    const c = await ensureCa(regenerate); return { ...c.info, certFile: c.certFile, certPem: c.certPem, created: !!c.created }; }));
  ipcMain.handle('proxy-ca-open', guard(async () => { const c = await ensureCa(); const error = await shell.openPath(c.certFile); if (error) throw new Error(error); return {}; }));
}

module.exports = { createProxy, matchesBreakpoint, stripHop, resealCaKey, register };
