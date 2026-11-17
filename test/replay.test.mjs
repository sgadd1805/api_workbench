// Re-sending a History entry with one change (renderer/app/replay.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const appended = [];
globalThis.window = { electronAPI: { storageSet() {}, historyAppend: (e) => appended.push(e) } };
const {
  wireFromEntry, redactedHeaders, fillRedacted, parseValue, parsePath, setAtPath, applyChange, describeChange, compareResponses, nameSuggestions, savableHeaders, renewCorrelation,
} = await import('../renderer/app/replay.js');
const { recordReplay, historyEntries, matchesQuery } = await import('../renderer/app/history.js');

const entry = (over = {}) => ({
  id: 'h1', at: 1, reqId: 'r1', reqName: 'Create order', projectId: 'p1', method: 'POST', url: 'https://api.test/orders?dry=1&tag=a&tag=b#top',
  request: {
    headers: { host: 'api.test', 'content-length': '40', 'Content-Type': 'application/json', Authorization: '•••• (redacted)', 'X-Trace': 't1', ':path': '/orders' },
    body: '{\n  "items": [{ "sku": "A", "qty": 1 }],\n  "note": "hi"\n}',
  },
  response: { status: 201, headers: { 'content-type': 'application/json', date: 'x', etag: '1' }, body: '{"id":7,"total":10}', time: 80 },
  ...over,
});

test('the wire from an entry drops headers of the old exchange', () => {
  const w = wireFromEntry(entry());
  assert.deepEqual(Object.keys(w.headers), ['Content-Type', 'Authorization', 'X-Trace']);
  assert.equal(w.url, 'https://api.test/orders?dry=1&tag=a&tag=b#top');
  const mp = wireFromEntry(entry({ request: { headers: {}, body: '', parts: [{ name: 'a', value: '1' }], file: undefined } }));
  assert.deepEqual(mp.bodyParts, [{ name: 'a', value: '1' }]);
});

test('blanked credentials are filled from the saved request, or left out', () => {
  const w = wireFromEntry(entry());
  assert.deepEqual(redactedHeaders(w), ['Authorization']);
  assert.deepEqual(fillRedacted(w, { authorization: 'Bearer fresh' }), []);
  assert.equal(w.headers.Authorization, 'Bearer fresh');
  const w2 = wireFromEntry(entry());
  assert.deepEqual(fillRedacted(w2, {}), ['Authorization']);
  assert.ok(!('Authorization' in w2.headers));
});

test('paths and values', () => {
  assert.deepEqual(parsePath('items[0].qty'), ['items', 0, 'qty']);
  assert.deepEqual(parsePath('$.items.0.qty'), ['items', 0, 'qty']);
  assert.deepEqual(parsePath('a["odd key"].b'), ['a', 'odd key', 'b']);
  assert.deepEqual([parseValue('5'), parseValue('true'), parseValue('null'), parseValue('"5"'), parseValue('plain text'), parseValue('{"a":1}')], [5, true, null, '5', 'plain text', { a: 1 }]);
  assert.equal(JSON.stringify(setAtPath({ a: { b: 1 } }, 'a.c[1].d', 2)), '{"a":{"b":1,"c":[null,{"d":2}]}}');
  assert.deepEqual(setAtPath({ a: [1, 2, 3] }, 'a[1]', null, true), { a: [1, 3] });
  assert.deepEqual(setAtPath({ a: 1 }, 'missing.deep', null, true), { a: 1 }, 'removing a missing path changes nothing');
});

test('one change at a time: header, query parameter, body field', () => {
  const w = wireFromEntry(entry());
  assert.equal(applyChange(w, { kind: 'header', name: 'x-trace', value: 't2' }).wire.headers['X-Trace'], 't2');
  assert.ok(!('X-Trace' in applyChange(w, { kind: 'header', name: 'X-TRACE', remove: true }).wire.headers));
  assert.equal(applyChange(w, { kind: 'header', name: 'X-New', value: 'v' }).wire.headers['X-New'], 'v');
  assert.equal(w.headers['X-Trace'], 't1', 'the original wire is untouched');
  assert.equal(applyChange(w, { kind: 'query', name: 'tag', value: 'c d' }).wire.url, 'https://api.test/orders?dry=1&tag=c%20d#top');
  assert.equal(applyChange(w, { kind: 'query', name: 'dry', remove: true }).wire.url, 'https://api.test/orders?tag=a&tag=b#top');
  assert.equal(applyChange({ ...w, url: 'https://h/x' }, { kind: 'query', name: 'a', value: '1' }).wire.url, 'https://h/x?a=1');
  const body = JSON.parse(applyChange(w, { kind: 'body', name: 'items[0].qty', value: '-1' }).wire.body);
  assert.deepEqual(body, { items: [{ sku: 'A', qty: -1 }], note: 'hi' });
  assert.match(applyChange(w, { kind: 'body', name: 'note', value: 'x' }).wire.body, /\n {2}"note": "x"/, 'pretty bodies stay pretty');
  assert.deepEqual(JSON.parse(applyChange(w, { kind: 'body', name: 'note', remove: true }).wire.body), { items: [{ sku: 'A', qty: 1 }] });
  assert.match(applyChange(w, { kind: 'header', name: ' ' }).error, /Name the header/);
  assert.match(applyChange({ ...w, body: '<xml/>' }, { kind: 'body', name: 'a', value: '1' }).error, /isn't JSON or a form/);
  // Form and multipart bodies change by field name; a file body has no fields.
  const form = { ...w, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=2' };
  assert.equal(applyChange(form, { kind: 'body', name: 'a', value: 'x y' }).wire.body, 'b=2&a=x%20y');
  const mp = { ...w, body: '', bodyParts: [{ name: 'title', value: 'old' }, { name: 'f', file: '/a.png' }] };
  assert.deepEqual(applyChange(mp, { kind: 'body', name: 'title', value: 'new' }).wire.bodyParts, [{ name: 'f', file: '/a.png' }, { name: 'title', value: 'new' }]);
  assert.match(applyChange({ ...w, body: '', bodyFile: '/x.bin' }, { kind: 'body', name: 'a', value: '1' }).error, /body is a file/);
});

test('labels', () => {
  assert.equal(describeChange({ kind: 'header', name: 'Accept', value: 'text/xml' }), 'header Accept: text/xml');
  assert.equal(describeChange({ kind: 'query', name: 'page', remove: true }), 'without ?page');
  assert.equal(describeChange({ kind: 'body', name: 'qty', value: 'x'.repeat(80) }), `body qty = ${'x'.repeat(57)}…`);
  assert.equal(describeChange({ kind: 'env' }, 'staging'), 'in environment staging');
  assert.equal(describeChange({ kind: 'none' }), 'sent again unchanged');
});

test('comparing the recorded response with the new one', () => {
  const a = entry().response;
  const b = { status: 400, headers: { 'Content-Type': 'application/problem+json', date: 'y', etag: '2' }, body: '{"title":"bad qty","id":7}', time: 12 };
  const c = compareResponses(a, b);
  assert.deepEqual(c.status, [201, 400]);
  assert.deepEqual(c.headers, [{ name: 'content-type', a: 'application/json', b: 'application/problem+json' }], 'date / etag are ignored');
  assert.deepEqual(c.fields.map((f) => [f.path, f.kind]).sort(), [['$.title', 'added'], ['$.total', 'removed']]);
  assert.equal(c.bodySame, false);
  assert.ok(c.stats.added > 0);
  const same = compareResponses(a, { ...a, body: '{"total":10,"id":7}' });
  assert.equal(same.bodySame, true, 'key order is not a change');
  assert.equal(compareResponses(a, { status: 200, headers: {}, body: 'plain' }).fields, null);
});

test('name suggestions per kind', () => {
  const e = entry();
  assert.deepEqual(nameSuggestions(e, 'header'), ['Content-Type', 'Authorization', 'X-Trace']);
  assert.deepEqual(nameSuggestions(e, 'query'), ['dry', 'tag']);
  assert.deepEqual(nameSuggestions(e, 'body'), ['items[0].sku', 'items[0].qty', 'note']);
  assert.deepEqual(nameSuggestions(entry({ request: { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1&y=2' } }), 'body'), ['x', 'y']);
  assert.deepEqual(nameSuggestions(entry({ request: { headers: {}, body: '{"odd key":{"a":1}}' } }), 'body'), ['["odd key"].a']);
  assert.deepEqual(parsePath(nameSuggestions(entry({ request: { headers: {}, body: '[{"a":1}]' } }), 'body')[0]), [0, 'a']);
});

test('a re-send is recorded under the same request, linked to the original, and searchable by its change', () => {
  const e = entry();
  const res = { status: 400, statusText: 'Bad Request', headers: {}, body: '{}', time: 5, requestData: { method: 'POST', url: e.url, headers: { a: '1' }, body: '{}' } };
  const out = recordReplay(e, res, { change: 'body qty = -1' });
  assert.equal(out.reqId, 'r1');
  assert.equal(out.replayOf, 'h1');
  assert.equal(out.change, 'body qty = -1');
  assert.equal(historyEntries()[0], out);
  assert.equal(appended.at(-1), out);
  assert.ok(matchesQuery(out, 'qty'));
  assert.equal(recordReplay(e, { cancelled: true }), null);
});

test('saving a recorded send drops the headers every send gets anyway; a re-send gets new correlation ids', () => {
  const sent = { host: 'h', 'content-length': '9', 'X-Request-Id': 'old', traceparent: '00-old-01', accept: '*/*', 'accept-encoding': 'gzip, deflate, br',
    'user-agent': 'api-workbench/1.0', 'Content-Type': 'application/json', Accept: 'application/xml', 'X-Tenant': 'a' };
  assert.deepEqual(savableHeaders(sent).map((h) => h.k), ['Content-Type', 'Accept', 'X-Tenant'], 'an accept the user chose is kept');
  const wire = renewCorrelation({ headers: { 'X-Request-Id': 'old', traceparent: '00-old-01', 'X-Tenant': 'a' } }, { requestId: 'new', traceparent: '00-new-01' });
  assert.deepEqual(wire.headers, { 'X-Request-Id': 'new', traceparent: '00-new-01', 'X-Tenant': 'a' });
  assert.deepEqual(renewCorrelation({ headers: { a: '1' } }, { requestId: 'n', traceparent: 't' }).headers, { a: '1' }, 'none added when the original had none');
});
