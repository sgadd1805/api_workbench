// TLS options (custom CA, ignore errors, client certificates), HTTP/HTTPS proxies and HTTP/2 in the transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';

const require = createRequire(import.meta.url);
const { proxyFetch } = require('../main/http.js');

const hasOpenssl = (() => { try { execFileSync('openssl', ['version']); return true; } catch { return false; } })();

// A throwaway CA, a server certificate for 127.0.0.1/localhost and a client certificate, all signed by it.
function makeCerts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'certs-'));
  const o = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'san.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  o('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=Test CA', '-days', '2');
  for (const name of ['server', 'client']) {
    o('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name === 'server' ? 'localhost' : 'tester'}`);
    o('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '2', ...(name === 'server' ? ['-extfile', 'san.ext'] : []));
  }
  const f = (n) => path.join(dir, n);
  return { dir, ca: f('ca.crt'), serverKey: f('server.key'), serverCrt: f('server.crt'), clientKey: f('client.key'), clientCrt: f('client.crt') };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const reply = (req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: req.url, cert: req.socket.getPeerCertificate?.()?.subject?.CN || null, version: req.httpVersion })); };

test('TLS: rejects unknown CA by default; custom CA file or "insecure" fixes it; client certificates', { skip: !hasOpenssl && 'openssl not available' }, async (t) => {
  const c = makeCerts();
  const server = https.createServer({ key: fs.readFileSync(c.serverKey), cert: fs.readFileSync(c.serverCrt) }, reply);
  const mtls = https.createServer({ key: fs.readFileSync(c.serverKey), cert: fs.readFileSync(c.serverCrt), ca: fs.readFileSync(c.ca), requestCert: true, rejectUnauthorized: true }, reply);
  const [port, mport] = [await listen(server), await listen(mtls)];
  t.after(() => { server.closeAllConnections(); server.close(); mtls.closeAllConnections(); mtls.close(); });
  const url = `https://127.0.0.1:${port}/x`;

  const plain = await proxyFetch({ url, method: 'GET', headers: {} });
  assert.equal(plain.ok, false);
  assert.match(plain.error, /UNABLE_TO_VERIFY_LEAF_SIGNATURE.*isn't trusted.*Network settings/);
  assert.doesNotMatch(plain.error, /--use-system-ca/);
  const withCa = await proxyFetch({ url, method: 'GET', headers: {}, network: { caFile: c.ca } });
  assert.equal(withCa.status, 200);
  assert.ok(withCa.timing.tls > 0);
  assert.equal((await proxyFetch({ url, method: 'GET', headers: {}, network: { insecure: true } })).status, 200);
  assert.match((await proxyFetch({ url, method: 'GET', headers: {}, network: { caFile: path.join(c.dir, 'missing.crt') } })).error, /CA certificate file not found/);

  const murl = `https://127.0.0.1:${mport}/m`;
  const noCert = await proxyFetch({ url: murl, method: 'GET', headers: {}, network: { caFile: c.ca } });
  assert.ok(!noCert.ok || noCert.status >= 400, 'server requiring a client certificate must refuse');
  const withCert = await proxyFetch({ url: murl, method: 'GET', headers: {}, network: { caFile: c.ca, certFile: c.clientCrt, keyFile: c.clientKey } });
  assert.equal(JSON.parse(withCert.body).cert, 'tester');
});

test('proxy: http via absolute-form, https via CONNECT, proxy credentials', { skip: !hasOpenssl && 'openssl not available' }, async (t) => {
  const c = makeCerts();
  const seen = [];
  const proxy = http.createServer((req, res) => { // plain http: forward absolute-form requests
    seen.push(['GET', req.url, req.headers['proxy-authorization'] || '']);
    const u = new URL(req.url);
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(up);
  });
  proxy.on('connect', (req, client, head) => { // https: tunnel
    seen.push(['CONNECT', req.url, req.headers['proxy-authorization'] || '']);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(port, host, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.write(head); upstream.pipe(client); client.pipe(upstream); });
  });
  const target = http.createServer(reply);
  const secure = https.createServer({ key: fs.readFileSync(c.serverKey), cert: fs.readFileSync(c.serverCrt) }, reply);
  const [pp, tp, sp] = [await listen(proxy), await listen(target), await listen(secure)];
  t.after(() => { for (const s of [proxy, target, secure]) { s.closeAllConnections?.(); s.close(); } });
  const network = { proxy: `http://bob:s%40cret@127.0.0.1:${pp}`, caFile: c.ca };
  assert.equal(JSON.parse((await proxyFetch({ url: `http://127.0.0.1:${tp}/plain`, method: 'GET', headers: {}, network })).body).path, '/plain');
  assert.equal(JSON.parse((await proxyFetch({ url: `https://127.0.0.1:${sp}/tunnel`, method: 'GET', headers: {}, network })).body).path, '/tunnel');
  const basic = 'Basic ' + Buffer.from('bob:s@cret').toString('base64');
  assert.deepEqual(seen.map(([m, u, a]) => [m, u.replace(/\d+/g, 'N'), a === basic]), [['GET', 'http://N.N.N.N:N/plain', true], ['CONNECT', 'N.N.N.N:N', true]]);
  const refused = await proxyFetch({ url: `https://127.0.0.1:${sp}/x`, method: 'GET', headers: {}, network: { proxy: 'http://127.0.0.1:9' } });
  assert.match(refused.error, /Proxy 127\.0\.0\.1:9/);
});

test('HTTP/2: requests over h2, session reuse, timing', { skip: !hasOpenssl && 'openssl not available' }, async (t) => {
  const c = makeCerts();
  const server = http2.createSecureServer({ key: fs.readFileSync(c.serverKey), cert: fs.readFileSync(c.serverCrt) });
  server.on('stream', (stream, headers) => {
    let body = ''; stream.on('data', (d) => (body += d)); stream.on('end', () => {
      stream.respond({ ':status': 201, 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] });
      stream.end(JSON.stringify({ path: headers[':path'], method: headers[':method'], body, x: headers['x-test'] }));
    });
  });
  const port = await listen(server);
  t.after(() => server.close());
  const network = { http2: true, caFile: c.ca };
  const r1 = await proxyFetch({ url: `https://127.0.0.1:${port}/h2?q=1`, method: 'POST', headers: { 'X-Test': 'yes', Connection: 'keep-alive' }, body: 'hi', network });
  assert.equal(r1.status, 201);
  assert.deepEqual(JSON.parse(r1.body), { path: '/h2?q=1', method: 'POST', body: 'hi', x: 'yes' });
  assert.equal(r1.timing.httpVersion, '2.0');
  assert.deepEqual(r1.setCookies, ['a=1', 'b=2']);
  assert.equal(r1.timing.reused, false);
  const r2 = await proxyFetch({ url: `https://127.0.0.1:${port}/again`, method: 'GET', headers: {}, network });
  assert.equal(r2.timing.reused, true);
});
