// Login-window capture → the Network list and opening one call in the app (main/har.js, renderer/app/capture.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

globalThis.window = { electronAPI: { storageSet() {} } };
const { HarRecorder, entrySummaries, entryDetail, harFromFile } = createRequire(import.meta.url)('../main/har.js');
const { requestFromCapture, filterCaptured, capturedOf, capturedDiff } = await import('../renderer/app/capture.js');

async function capture() {
  const bodies = { 1: { body: '{"token":"abc","user":{"id":7}}', base64Encoded: false }, 2: { body: Buffer.from('PNGDATA').toString('base64'), base64Encoded: true } };
  const rec = new HarRecorder(async (id) => bodies[id]);
  const sent = (id, method, url, extra = {}) => rec.handle('Network.requestWillBeSent', { requestId: id, type: 'Fetch', wallTime: 1767225600, timestamp: 10, request: { method, url, headers: { 'Content-Type': 'application/json', Host: 'x' }, ...extra } });
  sent('1', 'POST', 'https://auth.example.com/api/login?next=%2Fhome', { postData: '{"user":"bo"}' });
  rec.handle('Network.responseReceived', { requestId: '1', response: { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=1' }, mimeType: 'application/json' } });
  await rec.handle('Network.loadingFinished', { requestId: '1', timestamp: 10.25 });
  sent('2', 'GET', 'https://auth.example.com/avatar.png');
  rec.handle('Network.responseReceived', { requestId: '2', response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'image/png' } });
  await rec.handle('Network.loadingFinished', { requestId: '2', timestamp: 10.1 });
  sent('3', 'GET', 'https://api.example.com/me');
  rec.handle('Network.loadingFailed', { requestId: '3', timestamp: 11, errorText: 'net::ERR_CONNECTION_REFUSED' });
  return rec;
}

test('summaries carry what the Network list shows', async () => {
  const s = entrySummaries((await capture()).entries);
  assert.deepEqual(s.map((e) => [e.index, e.method, e.status, e.responseType, e.time, e.error]), [
    [0, 'POST', 200, 'application/json', 250, ''], [1, 'GET', 200, 'image/png', 100, ''], [2, 'GET', 0, '', 1000, 'net::ERR_CONNECTION_REFUSED']]);
  assert.equal(s[0].size, 31);
  assert.equal(s[0].at, '2026-01-01T00:00:00.000Z');
});

test('entryDetail: the request and the response the page got, shaped like a send result', async () => {
  const [login, image, failed] = (await capture()).entries.map(entryDetail);
  assert.deepEqual(login.request, { method: 'POST', url: 'https://auth.example.com/api/login?next=%2Fhome', headers: { 'Content-Type': 'application/json', Host: 'x' }, body: '{"user":"bo"}' });
  assert.deepEqual([login.response.status, login.response.statusText, login.response.body, login.response.headers['Set-Cookie'], login.response.time], [200, 'OK', '{"token":"abc","user":{"id":7}}', 'sid=1', 250]);
  assert.deepEqual([image.response.binary, image.response.body, Buffer.from(image.response.bodyBase64, 'base64').toString(), image.response.size], [true, '', 'PNGDATA', 7]);
  assert.deepEqual([failed.response.status, failed.response.error], [0, 'net::ERR_CONNECTION_REFUSED']);
  assert.equal(entryDetail(undefined), null);
});

test('filtering the list, newest first, and turning a call into a request', async () => {
  const s = entrySummaries((await capture()).entries);
  assert.deepEqual(filterCaptured(s, '').map((e) => e.index), [2, 1, 0]);
  assert.deepEqual(filterCaptured(s, 'auth.example').map((e) => e.index), [1, 0]);
  assert.deepEqual(filterCaptured(s, 'post login').map((e) => e.index), [0]);
  assert.deepEqual(filterCaptured(s, 'failed').map((e) => e.index), [2]);
  assert.deepEqual(filterCaptured(s, 'refused').map((e) => e.index), [2]);
  const r = requestFromCapture(s[0]);
  assert.deepEqual([r.name, r.method, r.url, r.body.type, r.headers.map((h) => h.k)], ['/api/login?next=%2Fhome', 'POST', 'https://auth.example.com/api/login?next=%2Fhome', 'json', ['Content-Type']]);
});

test('captured vs live: kept on the request, compared field by field on a later send', () => {
  const c = capturedOf({ status: 200, statusText: 'OK', body: '{"id":1,"status":"OPEN","items":[1]}' }, 5);
  assert.deepEqual(c, { status: 200, statusText: 'OK', body: '{"id":1,"status":"OPEN","items":[1]}', at: 5 });
  assert.equal(capturedOf({ status: 200, body: 'x'.repeat(200 * 1024) }).truncated, true);
  assert.deepEqual(capturedDiff(c, { status: 200, body: '{"items":[1],"status":"OPEN","id":1}' }), { status: null, fields: [], textChanged: false, same: true }, 'key order does not count');
  const d = capturedDiff(c, { status: 201, body: '{"id":2,"status":"OPEN","items":[1,2]}' });
  assert.deepEqual([d.status, d.fields.map((f) => f.path), d.same], [[200, 201], ['$.id', '$.items[1]'], false]);
  assert.deepEqual(capturedDiff({ status: 200, body: 'hello' }, { status: 200, body: 'hello!' }), { status: null, fields: null, textChanged: true, same: false });
  assert.equal(capturedDiff(c, { error: 'ECONNREFUSED' }), null);
});

test('HAR files from browser DevTools: API calls kept, static assets skipped, bodies readable', () => {
  const entry = (url, type, extra = {}) => ({ startedDateTime: '2026-01-01T00:00:00.000Z', time: 12.6, _resourceType: type,
    request: { method: 'GET', url, headers: [{ name: ':authority', value: 'x' }, { name: 'Accept', value: '*/*' }] },
    response: { status: 200, statusText: 'OK', headers: [{ name: 'content-type', value: 'application/json' }], content: { size: 9, mimeType: 'application/json', text: '{"ok":true}' } }, ...extra });
  const har = { log: { version: '1.2', entries: [
    entry('https://shop.test/', 'document'), entry('https://shop.test/app.js', 'script'), entry('https://shop.test/logo.png', 'image'),
    entry('https://shop.test/api/me', 'xhr'),
    entry('https://shop.test/api/orders', 'fetch', { request: { method: 'POST', url: 'https://shop.test/api/orders', headers: [], postData: { mimeType: 'application/json', text: '{"sku":"A"}' } } }),
    { request: { method: 'GET', url: 'https://shop.test/api/raw' }, response: { status: 200, content: { mimeType: 'application/json', text: btoa('{"b":64}'), encoding: 'base64' } } },
    { request: { method: 'GET', url: 'data:image/png;base64,AAAA' } },
  ] } };
  const { entries, skipped } = harFromFile(JSON.stringify(har));
  assert.equal(skipped, 4);
  assert.deepEqual(entries.map((e) => e.request.url), ['https://shop.test/api/me', 'https://shop.test/api/orders', 'https://shop.test/api/raw']);
  assert.deepEqual(entries[0].request.headers, [{ name: 'Accept', value: '*/*' }], 'HTTP/2 pseudo-headers dropped');
  const [me, orders, raw] = entries.map(entryDetail);
  assert.deepEqual([me.response.body, me.response.time, orders.request.body], ['{"ok":true}', 13, '{"sku":"A"}']);
  assert.equal(raw.response.body, '{"b":64}', 'base64 text bodies are decoded');
  assert.deepEqual(entrySummaries(entries).map((e) => [e.method, e.status]), [['GET', 200], ['POST', 200], ['GET', 200]]);
  assert.throws(() => harFromFile('nope'), /isn't JSON/);
  assert.throws(() => harFromFile('{"log":{}}'), /no log\.entries/);
});

test('captured bodies are kept without credentials, and blanked fields are not differences', () => {
  const c = capturedOf({ status: 200, body: '{"access_token":"tok_live","user":{"id":7,"password":"pw"},"csrf":"x1","items":[{"apiKey":"k"}],"expires_in":3600}' });
  assert.deepEqual(JSON.parse(c.body), { access_token: '[redacted]', user: { id: 7, password: '[redacted]' }, csrf: '[redacted]', items: [{ apiKey: '[redacted]' }], expires_in: 3600 });
  assert.ok(capturedDiff(c, { status: 200, body: '{"access_token":"tok_new","user":{"id":7,"password":"pw2"},"csrf":"x2","items":[{"apiKey":"k2"}],"expires_in":3600}' }).same);
  assert.equal(capturedOf({ status: 200, body: 'not json token=abc' }).body, 'not json token=abc');
});
