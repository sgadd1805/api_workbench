// Proxy traffic → mock: hosts, path generalisation, routes, and serving them with main/mock.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { recordedHosts, generalizePath, recordedRoutes } = await import('../renderer/app/recorded.js');
const mock = createRequire(import.meta.url)('../main/mock.js');

// Newest first, as the Proxy page keeps them.
const ex = [
  { method: 'GET', url: 'https://pay.test/v1/charges/ch_9f2c4e1a7b3d5f60', status: 200, responseHeaders: { 'content-type': 'application/json', 'x-req': 'b', 'content-length': '9' }, response: { body: '{"id":"9"}' } },
  { method: 'GET', url: 'https://pay.test/v1/charges/12', status: 404, responseHeaders: { 'content-type': 'application/json' }, response: { body: '{"error":"none"}' } },
  { method: 'GET', url: 'https://pay.test/v1/logo.png', status: 200, responseHeaders: { 'content-type': 'image/png' }, response: { binary: true, bodyBase64: Buffer.from([0x89, 0x50]).toString('base64') } },
  { method: 'POST', url: 'https://pay.test/v1/charges', status: 201, responseHeaders: { 'content-type': 'application/json' }, response: { body: '{"id":"1"}' } },
  { method: 'GET', url: 'https://other.test/x', status: 200, responseHeaders: {}, response: { body: 'x' } },
  { method: 'CONNECT', url: 'https://hidden.test:443', tunnel: true, status: 200 },
  { method: 'GET', url: 'https://pay.test/down', error: 'ECONNRESET' },
];

test('hosts and path generalisation', () => {
  assert.deepEqual(recordedHosts(ex), [{ host: 'pay.test', count: 4 }, { host: 'other.test', count: 1 }]);
  assert.equal(generalizePath('/v1/charges/12/refunds/550e8400-e29b-41d4-a716-446655440000'), '/v1/charges/{id}/refunds/{id2}');
  assert.equal(generalizePath('/v1/charges/latest'), '/v1/charges/latest');
  assert.equal(generalizePath('/users/507f1f77bcf86cd799439011'), '/users/{id}');
});

test('routes: grouped by method + path, latest status is the default, binary kept', () => {
  const routes = recordedRoutes(ex, { host: 'pay.test' });
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path} ${r.defaultCode} ${Object.keys(r.responses).join(',')}`), [
    'POST /v1/charges 201 201', 'GET /v1/charges/{id} 200 200,404', 'GET /v1/logo.png 200 200']);
  assert.deepEqual(routes[1].responses['200'].headers, { 'x-req': 'b' });
  assert.equal(recordedRoutes(ex, { host: 'pay.test', generalize: false }).length, 4);
});

test('served by the mock server: default, recorded alternative, binary', async (t) => {
  const routes = recordedRoutes(ex, { host: 'pay.test' });
  const { url } = await mock.start({ id: 'rec-test', routes }, () => {});
  t.after(() => mock.stop('rec-test'));
  let r = await fetch(url + '/v1/charges/77');
  assert.equal(r.status, 200); assert.equal(await r.text(), '{"id":"9"}'); assert.equal(r.headers.get('x-req'), 'b');
  r = await fetch(url + '/v1/charges/77', { headers: { 'X-Mock-Status': '404' } });
  assert.equal(r.status, 404); assert.equal(await r.text(), '{"error":"none"}');
  r = await fetch(url + '/v1/logo.png');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0x89, 0x50]);
  assert.equal(r.headers.get('content-type'), 'image/png');
  routes[1].override = '404'; mock.update({ id: 'rec-test', routes });
  assert.equal((await fetch(url + '/v1/charges/1')).status, 404);
});
