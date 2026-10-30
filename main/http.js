'use strict';
// Sends the renderer's requests from the main process with Node's http/https modules. Unlike a
// browser (or even Node's fetch, which adds sec-fetch-mode / accept-language / a text/plain
// Content-Type), only the headers the request specifies go out, plus Host, Content-Length,
// Connection and defaults for Accept / Accept-Encoding / User-Agent when it doesn't set them.
// Every send is timed per phase (DNS, TCP, TLS, request, waiting for the first byte, download).
// Requests can be cancelled by id and time out after timeoutMs (0 = never). Per-environment TLS,
// client-certificate, proxy and HTTP/2 settings come in as `network` (see main/network.js).
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { agentFor, httpProxyTarget, h2Session } = require('./network');

const MAX_REDIRECTS = 20;
const DEFAULT_HEADERS = { accept: '*/*', 'accept-encoding': 'gzip, deflate, br', 'user-agent': 'api-workbench/1.0' };
const inflight = new Map(); // id → AbortController

const round = (ms) => Math.round(ms * 10) / 10;

function withDefaults(headers) {
  const out = { ...headers };
  const has = (k) => Object.keys(out).some((x) => x.toLowerCase() === k);
  for (const [k, v] of Object.entries(DEFAULT_HEADERS)) if (!has(k)) out[k] = v;
  return out;
}

const TEXTUAL = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded|graphql|yaml|x-yaml|problem\+json)\b)|^image\/svg\+xml/i;
const isBinary = (type) => !!type && /^(image|audio|video|font)\/|^application\/(pdf|octet-stream|zip|gzip|x-tar|vnd\.|msword|x-protobuf|protobuf|grpc)/i.test(type) && !TEXTUAL.test(type);

function decode(buffer, encoding) {
  switch ((encoding || '').trim().toLowerCase()) {
    case 'gzip': case 'x-gzip': return zlib.gunzipSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    case 'deflate': try { return zlib.inflateSync(buffer); } catch { return zlib.inflateRawSync(buffer); }
    case 'br': return zlib.brotliDecompressSync(buffer);
    default: return buffer;
  }
}

// One HTTP exchange (no redirect following). → { res, body: Buffer, timing }
// timing (ms from the start of this hop): { dns, tcp, tls, request, wait, download, total, reused, remoteAddress }
function exchange(url, opts) {
  if (opts.network?.http2 && url.protocol === 'https:') return exchangeH2(url, opts);
  const { method, headers, body, signal, network } = opts;
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const marks = {};
    const mark = (k) => { if (marks[k] === undefined) marks[k] = performance.now() - t0; };
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body ? Buffer.from(body) : null;
    const sentHeaders = { host: url.host, ...headers, ...(payload && { 'content-length': String(payload.length) }) };
    let req;
    try {
      const viaProxy = httpProxyTarget(url, network);
      req = viaProxy
        ? http.request({ host: viaProxy.host, port: viaProxy.port, path: viaProxy.path, method, signal, headers: { ...sentHeaders, ...viaProxy.extraHeaders } })
        : mod.request(url, { method, signal, agent: agentFor(url.protocol, network), headers: sentHeaders });
    } catch (err) { return reject(err); }
    let reused = false, remoteAddress = '';
    req.on('socket', (socket) => {
      mark('socket');
      reused = !socket.connecting;
      if (reused) { mark('lookup'); mark('connect'); mark('secure'); return; }
      socket.once('lookup', () => mark('lookup'));
      socket.once('connect', () => { mark('lookup'); mark('connect'); remoteAddress = socket.remoteAddress || ''; if (url.protocol !== 'https:') mark('secure'); });
      socket.once('secureConnect', () => mark('secure'));
    });
    req.on('finish', () => mark('sent'));
    req.on('error', reject);
    req.on('response', (res) => {
      mark('firstByte');
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Response aborted')));
      res.on('end', () => {
        mark('end');
        remoteAddress ||= res.socket?.remoteAddress || '';
        const m = { lookup: 0, connect: 0, secure: 0, sent: 0, ...marks };
        m.connect = Math.max(m.connect, m.lookup); m.secure = Math.max(m.secure, m.connect); m.sent = Math.max(m.sent, m.secure);
        const timing = {
          dns: round(reused ? 0 : m.lookup - (m.socket || 0)),
          tcp: round(m.connect - m.lookup),
          tls: round(url.protocol === 'https:' ? m.secure - m.connect : 0),
          request: round(m.sent - m.secure),
          wait: round(m.firstByte - m.sent),
          download: round(m.end - m.firstByte),
          total: round(m.end),
          reused, remoteAddress,
        };
        resolve({ res, body: Buffer.concat(chunks), timing, sentHeaders });
      });
    });
    req.end(payload || undefined);
  });
}

// HTTP/2 (https only). Same result shape as exchange(); connection phases are measured when a new
// session is opened, and are zero when an existing session is reused.
function exchangeH2(url, { method, headers, body, signal, network }) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const marks = {};
    const mark = (k) => { if (marks[k] === undefined) marks[k] = performance.now() - t0; };
    let session, reused;
    try { ({ session, reused } = h2Session(url, network)); } catch (err) { return reject(err); }
    const payload = body ? Buffer.from(body) : null;
    // HTTP/2 forbids connection-specific headers; Host becomes :authority.
    const banned = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection']);
    const h2headers = { ':method': method, ':path': url.pathname + url.search, ':authority': url.host, ':scheme': 'https' };
    for (const [k, v] of Object.entries(headers)) if (!banned.has(k.toLowerCase())) h2headers[k.toLowerCase()] = v;
    if (payload) h2headers['content-length'] = String(payload.length);
    const start = () => {
      mark('secure'); mark('connect'); mark('lookup');
      const stream = session.request(h2headers, { signal });
      let resHeaders = {};
      stream.on('response', (h) => { mark('firstByte'); resHeaders = h; });
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => {
        mark('end'); mark('sent');
        const { ':status': status, ...rest } = resHeaders;
        const res = { statusCode: status, statusMessage: '', headers: rest, httpVersion: '2.0', socket: session.socket };
        const m = { lookup: 0, connect: 0, secure: 0, ...marks };
        resolve({
          res, body: Buffer.concat(chunks), sentHeaders: h2headers,
          timing: { dns: 0, tcp: reused ? 0 : round(m.connect), tls: reused ? 0 : round(m.secure - m.connect), request: 0, wait: round(m.firstByte - m.secure), download: round(m.end - m.firstByte), total: round(m.end), reused, remoteAddress: session.socket?.remoteAddress || '' },
        });
      });
      stream.end(payload || undefined);
    };
    if (reused || session.connected) start(); else { session.once('connect', start); session.once('error', reject); }
  });
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

// Certificate failures get a pointer to the settings that fix them (instead of Node's command-line hint).
const CERT_ERRORS = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED']);
function describeError(err) {
  const msg = err.message.replace(/;? ?if the root CA is installed locally.*$/i, '');
  const text = err.code && !msg.includes(err.code) ? `${err.code}: ${msg}` : msg;
  return CERT_ERRORS.has(err.code)
    ? `${text}. The server's certificate isn't trusted: add its CA file, or tick "Ignore certificate errors", in the environment's Network settings.`
    : text;
}

async function proxyFetch({ id, url, method = 'GET', headers = {}, body, timeoutMs = 0, redirect = 'follow', network = null }) {
  const ctrl = new AbortController();
  if (id) inflight.set(id, ctrl);
  const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(new Error(`Timed out after ${timeoutMs / 1000} s`)), timeoutMs) : null;
  const started = performance.now();
  const hops = [];
  try {
    let target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) throw new Error(`Unsupported protocol ${target.protocol}`);
    let opts = { method, headers: withDefaults(headers), body, signal: ctrl.signal, network };
    for (let n = 0; ; n++) {
      const { res, body: raw, timing, sentHeaders } = await exchange(target, opts);
      const location = res.headers.location;
      if (redirect === 'follow' && REDIRECT.has(res.statusCode) && location && n < MAX_REDIRECTS) {
        hops.push({ url: target.href, status: res.statusCode, timing });
        const next = new URL(location, target);
        // 303 (and 301/302 for POST, as browsers do) switch to GET without a body; 307/308 resend as-is.
        const toGet = res.statusCode === 303 || ([301, 302].includes(res.statusCode) && opts.method === 'POST');
        let nextHeaders = opts.headers;
        if (toGet) nextHeaders = Object.fromEntries(Object.entries(nextHeaders).filter(([k]) => !/^content-(type|length)$/i.test(k)));
        // Don't carry credentials to another origin.
        if (next.origin !== target.origin) nextHeaders = Object.fromEntries(Object.entries(nextHeaders).filter(([k]) => !/^(authorization|cookie)$/i.test(k)));
        opts = { ...opts, method: toGet ? 'GET' : opts.method, body: toGet ? undefined : opts.body, headers: nextHeaders };
        target = next;
        continue;
      }
      const decoded = decode(raw, res.headers['content-encoding']);
      // Binary bodies (images, PDFs, archives…) also come back as base64 for previews and saving;
      // the text body is then a short placeholder rather than mojibake.
      const binary = isBinary(res.headers['content-type']);
      const text = binary ? `(binary ${res.headers['content-type'] || ''}, ${decoded.length} bytes)` : decoded.toString('utf8');
      const resHeaders = {};
      for (const [k, v] of Object.entries(res.headers)) resHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
      const setCookies = [].concat(res.headers['set-cookie'] || []);
      return {
        ok: true, status: res.statusCode, statusText: res.statusMessage || '', headers: resHeaders, setCookies, body: text,
        ...(binary && { binary: true, bodyBase64: decoded.toString('base64'), size: decoded.length }),
        url: target.href, sentHeaders, // exactly what went out on the final hop
        timing: { ...timing, redirects: hops, overall: round(performance.now() - started), httpVersion: res.httpVersion },
      };
    }
  } catch (err) {
    if (ctrl.signal.aborted) return { ok: false, cancelled: true, error: ctrl.signal.reason?.message || 'Cancelled' };
    return { ok: false, error: describeError(err) };
  } finally {
    clearTimeout(timer);
    if (id) inflight.delete(id);
  }
}

function cancel(id) {
  inflight.get(id)?.abort(new Error('Cancelled'));
  return true;
}

function register(ipcMain) {
  ipcMain.handle('do-fetch', (_e, opts) => proxyFetch(opts));
  ipcMain.handle('cancel-fetch', (_e, id) => cancel(id));
}

module.exports = { proxyFetch, cancel, register, isBinary, decode };
