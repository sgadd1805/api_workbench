// Intercepting proxy: plain HTTP, decrypted HTTPS via CONNECT with the local CA, pass-through tunnels,
// breakpoints (edit / drop), and the CA itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { createProxy, matchesBreakpoint, stripHop } = require('../main/proxy.js');
const { loadOrCreateCa, leafSigner, caInfo } = require('../main/proxyca.js');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// An HTTP request through the proxy (absolute-form URL).
function viaProxy(proxyPort, url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method, path: url, headers: { host: new URL(url).host, ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

// An HTTPS request through a CONNECT tunnel, trusting `ca`.
function viaTunnel(proxyPort, host, port, pathName, ca) {
  return new Promise((resolve, reject) => {
    const c = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `${host}:${port}` });
    c.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error('CONNECT ' + res.statusCode));
      const req = https.request({ host, port, path: pathName, socket, agent: false, ca, servername: host }, (r) => {
        const chunks = []; r.on('data', (x) => chunks.push(x)); r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString(), cert: socket }));
      });
      req.on('error', reject); req.end();
    });
    c.on('error', reject); c.end();
  });
}

test('breakpoint rules and hop-by-hop headers', () => {
  assert.equal(matchesBreakpoint(['/api/orders'], 'POST', 'http://x/api/orders/1'), true);
  assert.equal(matchesBreakpoint(['POST /api/orders'], 'GET', 'http://x/api/orders/1'), false);
  assert.equal(matchesBreakpoint(['post /API/orders'], 'POST', 'http://x/api/orders'), true);
  assert.equal(matchesBreakpoint(['', '  '], 'GET', 'http://x/'), false);
  assert.deepEqual(stripHop({ Connection: 'keep-alive, X-Foo', 'x-foo': '1', 'proxy-connection': 'k', a: 'b' }), { a: 'b' });
});

test('local CA: created once, reloaded, signs leaves a client can verify', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-ca-'));
  const seal = (s) => 'S:' + Buffer.from(s).toString('base64'), unseal = (s) => Buffer.from(s.slice(2), 'base64').toString();
  const ca = await loadOrCreateCa(dir, { seal, unseal });
  assert.equal(ca.created, true);
  assert.match(fs.readFileSync(path.join(dir, 'ca.key'), 'utf8'), /^S:/); // key stored sealed
  const again = await loadOrCreateCa(dir, { seal, unseal });
  assert.equal(again.created, undefined); assert.equal(again.certPem, ca.certPem);
  assert.match(caInfo(ca.certPem).subject, /API Workbench local proxy CA/);
  const leaf = new crypto.X509Certificate(leafSigner(ca).certFor('api.example.test'));
  assert.equal(leaf.verify(new crypto.X509Certificate(ca.certPem).publicKey), true);
  assert.equal(leaf.checkHost('api.example.test'), 'api.example.test');
  assert.equal(new crypto.X509Certificate(leafSigner(ca).certFor('127.0.0.1')).checkIP('127.0.0.1'), '127.0.0.1');
});

test('proxy: records HTTP, decrypts HTTPS, tunnels when not decrypting, breakpoints edit and drop', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-ca-'));
  const ca = await loadOrCreateCa(dir);
  const signer = leafSigner(ca);
  // Upstreams: plain HTTP (gzip JSON) and HTTPS with a certificate from the same CA ("the real server").
  const seen = [];
  const handler = (req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, h: req.headers });
      if (req.url === '/img') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      res.end(zlib.gzipSync(JSON.stringify({ path: req.url, body })));
    });
  };
  const plain = http.createServer(handler);
  const secure = https.createServer({ SNICallback: (n, cb) => cb(null, signer.contextFor(n || 'localhost')) }, handler);
  const [pp, sp] = [await listen(plain), await listen(secure)];
  const exchanges = [], pauses = [];
  const proxy = createProxy({ decryptHttps: true, signer, caPem: ca.certPem, insecureUpstream: false, breakpoints: [],
    onExchange: (x) => exchanges.push(x), onPause: (p) => pauses.push(p) });
  const port = await proxy.listen();
  t.after(async () => { await proxy.close(); plain.close(); secure.close(); });

  // Plain HTTP: forwarded, client gets the gzip body as sent, record has it decoded.
  let r = await viaProxy(port, `http://127.0.0.1:${pp}/hello?x=1`, { method: 'POST', body: 'ping', headers: { 'content-type': 'text/plain', 'proxy-connection': 'keep-alive' } });
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1).url, '/hello?x=1'); assert.equal(seen.at(-1).h['proxy-connection'], undefined);
  let x = exchanges.at(-1);
  assert.equal(x.method, 'POST'); assert.equal(x.request.body, 'ping');
  assert.deepEqual(JSON.parse(x.response.body), { path: '/hello?x=1', body: 'ping' });
  assert.ok(x.time >= 0);
  await viaProxy(port, `http://127.0.0.1:${pp}/img`);
  assert.equal(exchanges.at(-1).response.binary, true);

  // HTTPS through CONNECT, decrypted: the client trusts the proxy CA; the proxy trusts the upstream (same CA here).
  proxy.update({ insecureUpstream: true });
  r = await viaTunnel(port, 'localhost', sp, '/secure', ca.certPem);
  assert.equal(r.status, 200);
  x = exchanges.at(-1);
  assert.equal(x.url, `https://localhost:${sp}/secure`);
  assert.deepEqual(JSON.parse(x.response.body), { path: '/secure', body: '' });

  // Not decrypting: tunnel only, the host is recorded when it closes.
  proxy.update({ decryptHttps: false });
  r = await viaTunnel(port, 'localhost', sp, '/through', ca.certPem);
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(exchanges.some((e) => e.method === 'CONNECT' && e.tunnel && e.url === `https://localhost:${sp}`));

  // Breakpoint: edited and forwarded.
  proxy.update({ breakpoints: ['POST /orders'] });
  const pending = viaProxy(port, `http://127.0.0.1:${pp}/orders`, { method: 'POST', body: '{"qty":1}', headers: { 'content-type': 'application/json' } });
  while (!pauses.length) await new Promise((res) => setTimeout(res, 10));
  assert.equal(pauses[0].body, '{"qty":1}');
  assert.deepEqual(proxy.pausedIds(), [pauses[0].id]);
  proxy.resume(pauses[0].id, { action: 'forward', request: { method: 'POST', url: `http://127.0.0.1:${pp}/orders?edited=1`, headers: { 'content-type': 'application/json', 'content-length': '9' }, body: '{"qty":99}' } });
  r = await pending;
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1).url, '/orders?edited=1'); assert.equal(seen.at(-1).body, '{"qty":99}'); assert.equal(seen.at(-1).h['content-length'], '10');
  assert.equal(exchanges.at(-1).edited, true);

  // Breakpoint: dropped.
  const dropped = viaProxy(port, `http://127.0.0.1:${pp}/orders`, { method: 'POST', body: 'x' });
  while (pauses.length < 2) await new Promise((res) => setTimeout(res, 10));
  proxy.resume(pauses[1].id, { action: 'drop' });
  assert.equal((await dropped).status, 502);
  assert.equal(exchanges.at(-1).error, 'Dropped at breakpoint');

  // The proxy's own page and the CA download.
  const own = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/ca.crt' }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); }));
  assert.equal(own, ca.certPem);
});
