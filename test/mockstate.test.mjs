// Mock server: stateful mode (POST stores, GET / PUT / PATCH / DELETE on the item, list on the collection) and
// injected faults (random failures, fail-first, dropped / hung connections, extra latency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';

globalThis.window = { electronAPI: {} };
const require = createRequire(import.meta.url);
const mock = require('../main/mock.js');
const { analyzeSpec } = await import('../renderer/app/openapi/spec.js');
const { mockRoutes } = await import('../renderer/app/openapi/mock.js');

const pet = { type: 'object', required: ['status'], properties: { id: { type: 'integer', readOnly: true }, name: { type: 'string', example: 'Rex' }, tag: { type: 'string' }, status: { type: 'string', example: 'available' } } };
const spec = analyzeSpec({ openapi: '3.0.0', servers: [{ url: '/api' }], paths: {
  '/pets': {
    get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: pet }, total: { type: 'integer' } } } } } } } },
    post: { responses: { 201: { content: { 'application/json': { schema: pet } } } } },
  },
  '/pets/{id}': {
    get: { responses: { 200: { content: { 'application/json': { schema: pet } } }, 404: {} } },
    put: { responses: { 200: { content: { 'application/json': { schema: pet } } } } },
    patch: { responses: { 200: { content: { 'application/json': { schema: pet } } } } },
    delete: { responses: { 204: {} } },
  },
  '/owners/{ownerId}/notes': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { uuid: { type: 'string' }, text: { type: 'string' } } } } } } } } },
    post: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { uuid: { type: 'string' }, text: { type: 'string' } } } } } } } } },
} });

async function startMock(t, opts = {}) {
  const hits = [];
  const id = `ms-${Math.random().toString(36).slice(2)}`;
  const { url } = await mock.start({ id, routes: mockRoutes(spec), basePath: '/api', ...opts }, (h) => hits.push(h));
  t.after(() => mock.stop(id));
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(url + path, { method, headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers }, ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { id, url, hits, call };
}

test('stateful: create, read, list, replace, merge, delete; examples until something is written', async (t) => {
  const { id, call, hits } = await startMock(t, { stateful: true });
  // Nothing written yet: the examples answer.
  assert.deepEqual((await call('GET', '/pets/42')).json, { id: 0, name: 'Rex', tag: 'string', status: 'available' });
  assert.deepEqual((await call('GET', '/pets')).json, { items: [{ id: 0, name: 'Rex', tag: 'string', status: 'available' }], total: 0 });
  const a = await call('POST', '/pets', { name: 'Fido' });
  assert.equal(a.status, 201);
  assert.deepEqual(a.json, { status: 'available', name: 'Fido', id: 1 }, 'the example fills required fields the body leaves out, not optional ones');
  assert.match(a.headers.get('x-mock-state'), /created id 1 in \/pets/);
  const b = await call('POST', '/pets', { name: 'Bella', tag: 'cat' });
  assert.equal(b.json.id, 2);
  assert.deepEqual((await call('GET', '/pets/1')).json, { status: 'available', name: 'Fido', id: 1 });
  const list = (await call('GET', '/pets')).json;
  assert.deepEqual(list.items.map((p) => p.name), ['Fido', 'Bella']);
  assert.equal(list.total, 2, 'counts follow the list');
  assert.deepEqual((await call('PUT', '/pets/2', { name: 'Bella II' })).json, { name: 'Bella II', id: 2 });
  assert.deepEqual((await call('PATCH', '/pets/1', { tag: 'dog' })).json, { status: 'available', name: 'Fido', id: 1, tag: 'dog' });
  assert.equal((await call('DELETE', '/pets/1')).status, 204);
  const gone = await call('GET', '/pets/1');
  assert.equal(gone.status, 404);
  assert.match(gone.json.detail, /nothing with id 1/);
  assert.equal((await call('PATCH', '/pets/99', { a: 1 })).status, 404);
  assert.equal((await call('POST', '/pets', '{not json')).status, 400);
  assert.deepEqual(mock.stateOf(id), [{ path: '/pets', count: 1 }]);
  assert.ok(hits.some((h) => /state: deleted 1/.test(h.note || '')));
  // Reset forgets everything: back to the examples.
  mock.reset(id);
  assert.deepEqual((await call('GET', '/pets/2')).json, { id: 0, name: 'Rex', tag: 'string', status: 'available' });
});

test('stateful: nested collections, string ids, and a forced status wins', async (t) => {
  const { call } = await startMock(t, { stateful: true });
  const n = await call('POST', '/owners/7/notes', { text: 'hi' });
  assert.equal(n.status, 200, 'the documented success code');
  assert.match(n.json.uuid, /^[0-9a-f-]{36}$/, 'string ids get a UUID');
  assert.deepEqual((await call('GET', '/owners/7/notes')).json.map((x) => x.text), ['hi']);
  assert.deepEqual((await call('GET', '/owners/8/notes')).json, [{ uuid: 'string', text: 'string' }], 'another owner: the example');
  assert.equal((await call('POST', '/pets', { name: 'x' }, { 'X-Mock-Status': '500' })).status, 500);
  assert.equal((await call('GET', '/pets')).json.total, 0, 'the forced call stored nothing');
});

test('stateless (default): writes are not remembered', async (t) => {
  const { call } = await startMock(t);
  await call('POST', '/pets', { name: 'Fido' });
  assert.deepEqual((await call('GET', '/pets/1')).json, { id: 0, name: 'Rex', tag: 'string', status: 'available' });
});

test('faults: random failures by rate, with Retry-After and the fault header', async (t) => {
  const seq = [0.1, 0.9, 0.1, 0.9]; let i = 0;
  const { call, hits } = await startMock(t, { faults: { errorRate: 50, errorStatus: '503' }, random: () => seq[i++ % seq.length] });
  const statuses = [];
  for (let k = 0; k < 4; k++) statuses.push(await call('GET', '/pets/1'));
  assert.deepEqual(statuses.map((s) => s.status), [503, 200, 503, 200]);
  assert.equal(statuses[0].headers.get('retry-after'), '1');
  assert.equal(statuses[0].headers.get('x-mock-fault'), 'random');
  assert.equal(statuses[0].json.status, 503);
  assert.ok(hits.filter((h) => h.note === 'fault: random').length === 2);
});

test('faults: fail the first N calls per endpoint, then succeed; reset starts counting again', async (t) => {
  const { id, call } = await startMock(t, { faults: { failFirst: 2, errorStatus: '500' } });
  const a = [await call('GET', '/pets/1'), await call('GET', '/pets/1'), await call('GET', '/pets/1')].map((r) => r.status);
  assert.deepEqual(a, [500, 500, 200]);
  assert.equal((await call('GET', '/pets/2')).status, 500, 'each path counts on its own');
  assert.equal((await call('GET', '/pets/1')).headers.get('x-mock-fault'), null);
  mock.reset(id);
  assert.equal((await call('GET', '/pets/1')).status, 500);
  // Changing faults while running restarts the counts too.
  mock.update({ id, faults: { failFirst: 0 } });
  assert.equal((await call('GET', '/pets/1')).status, 200);
});

test('faults: a dropped connection, and a hang that never answers', async (t) => {
  const { id, call } = await startMock(t, { faults: { errorRate: 100, errorStatus: 'drop' }, random: () => 0 });
  await assert.rejects(call('GET', '/pets/1'));
  mock.update({ id, faults: { errorRate: 100, errorStatus: 'hang' } });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300);
  const t0 = Date.now();
  await assert.rejects(fetch(mock.running().find((s) => s.id === id) && `http://127.0.0.1:${mock.running().find((s) => s.id === id).port}/api/pets/1`, { signal: ctrl.signal }));
  clearTimeout(timer);
  assert.ok(Date.now() - t0 >= 250, 'no answer until the client gave up');
});

test('faults: jitter and slow responses add latency', async (t) => {
  const { call, hits } = await startMock(t, { faults: { slowRate: 100, slowMs: 150, jitterMs: 0 }, random: () => 0 });
  const t0 = Date.now();
  assert.equal((await call('GET', '/pets/1')).status, 200);
  assert.ok(Date.now() - t0 >= 140);
  assert.ok(hits[0].ms >= 140, 'the hit log counts the wait');
});

test('a stopped mock drops its hung connections', async () => {
  const id = 'ms-hang-stop';
  const { port } = await mock.start({ id, routes: mockRoutes(spec), basePath: '/api', faults: { errorRate: 100, errorStatus: 'hang' }, random: () => 0 }, () => {});
  const closed = new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET /api/pets/1 HTTP/1.1\r\nHost: x\r\n\r\n'));
    s.on('close', resolve); s.on('error', resolve);
  });
  await new Promise((r) => setTimeout(r, 50));
  await mock.stop(id);
  await closed;
});
