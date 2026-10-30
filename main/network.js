'use strict';
// Per-environment network settings for main/http.js:
//   { caFile, insecure, certFile, keyFile, pfxFile, passphrase, proxy, http2 }
// caFile: extra trusted CA (PEM) — for company / self-signed certificates; insecure: skip certificate
// checks; certFile+keyFile (PEM) or pfxFile (+passphrase): client certificate (mutual TLS);
// proxy: http://[user:pass@]host:port for both http and https targets (https via CONNECT);
// http2: use HTTP/2 for https targets.
const http = require('http');
const https = require('https');
const http2 = require('http2');
const tls = require('tls');
const fs = require('fs');
const net = require('net');

const fileCache = new Map(); // path → { mtimeMs, data }
function readFile(path, what) {
  if (!path) return undefined;
  let st;
  try { st = fs.statSync(path); } catch { throw new Error(`${what} not found: ${path}`); }
  const hit = fileCache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
  const data = fs.readFileSync(path);
  fileCache.set(path, { mtimeMs: st.mtimeMs, data });
  return data;
}

// TLS options for https / http2 connections.
function tlsOptions(net = {}) {
  const extraCa = readFile(net.caFile, 'CA certificate file');
  return {
    // A custom CA is added to (not instead of) the system's default roots.
    ...(extraCa && { ca: [...tls.rootCertificates, extraCa.toString()] }),
    rejectUnauthorized: !net.insecure,
    ...(net.pfxFile ? { pfx: readFile(net.pfxFile, 'Client certificate (PFX)'), passphrase: net.passphrase || undefined }
      : net.certFile ? { cert: readFile(net.certFile, 'Client certificate'), key: readFile(net.keyFile, 'Client key'), passphrase: net.passphrase || undefined } : {}),
  };
}

const proxyAuthHeader = (proxy) => (proxy.username ? { 'proxy-authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64') } : {});

// https through an HTTP proxy: open a CONNECT tunnel, then TLS over it.
class TunnelAgent extends https.Agent {
  constructor(proxyUrl, options) { super({ keepAlive: true, ...options }); this.proxy = new URL(proxyUrl); }
  createConnection(options, done) {
    const target = `${options.host}:${options.port}`;
    const req = http.request({ host: this.proxy.hostname, port: this.proxy.port || 80, method: 'CONNECT', path: target, headers: { host: target, ...proxyAuthHeader(this.proxy) } });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return done(new Error(`Proxy refused CONNECT to ${target}: HTTP ${res.statusCode}`)); }
      // SNI only for host names (TLS forbids IP addresses as server names).
      const name = options.servername || options.host;
      try { done(null, tls.connect({ ...options, socket, servername: net.isIP(name) ? undefined : name })); } catch (err) { socket.destroy(); done(err); }
    });
    req.once('error', (err) => done(new Error(`Proxy ${this.proxy.host}: ${err.message}`)));
    req.end();
  }
}

const agents = new Map(); // settings key → Agent
const DEFAULT_AGENTS = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };

const isDefault = (net) => !net || !(net.caFile || net.insecure || net.certFile || net.pfxFile || net.proxy);

// The agent for a URL's protocol under these settings (one per distinct settings, reused).
function agentFor(protocol, net) {
  if (isDefault(net)) return DEFAULT_AGENTS[protocol];
  const key = protocol + JSON.stringify(net);
  if (!agents.has(key)) {
    if (protocol === 'https:') agents.set(key, net.proxy ? new TunnelAgent(net.proxy, tlsOptions(net)) : new https.Agent({ keepAlive: true, ...tlsOptions(net) }));
    else agents.set(key, new http.Agent({ keepAlive: true }));
  }
  return agents.get(key);
}

// Plain-http requests through a proxy go to the proxy with the absolute URL as the path.
function httpProxyTarget(url, net) {
  if (!net?.proxy || url.protocol !== 'http:') return null;
  const proxy = new URL(net.proxy);
  return { host: proxy.hostname, port: proxy.port || 80, path: url.href, extraHeaders: proxyAuthHeader(proxy) };
}

// ---- HTTP/2
const sessions = new Map(); // origin + settings → ClientHttp2Session
function h2Session(url, net) {
  const key = url.origin + JSON.stringify(net || {});
  const existing = sessions.get(key);
  if (existing && !existing.closed && !existing.destroyed) return { session: existing, reused: true };
  const session = http2.connect(url.origin, tlsOptions(net));
  session.on('close', () => sessions.delete(key));
  session.on('error', () => sessions.delete(key));
  session.setTimeout(60000, () => session.close());
  sessions.set(key, session);
  return { session, reused: false };
}

module.exports = { agentFor, httpProxyTarget, h2Session, tlsOptions, isDefault };
