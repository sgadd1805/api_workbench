// Response viewer pieces (JSONPath filter, highlighting, binary detection, file names) and moving requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

globalThis.window = { electronAPI: { storageSet() {} } };
const { query } = await import('../renderer/app/jsonpath.js');
const { highlight, matchBracket, langFor } = await import('../renderer/shared/highlight.js');
const { DB, findReq, addProject, addFolder, addRequest, newReq, placeRequest } = await import('../renderer/app/store.js');
const { bodyFileName, previewKind } = await import('../renderer/app/views/viewer.js');
const { isBinary } = createRequire(import.meta.url)('../main/http.js');

const data = { store: { book: [{ t: 'a', price: 8 }, { t: 'b', price: 12 }, { t: 'c', price: 9, isbn: '1' }], bike: { price: 20 } }, 'odd key': 1 };

test('JSONPath: keys, indexes, wildcards, recursive descent, slices, unions, filters', () => {
  assert.deepEqual(query(data, '$.store.book[0].t'), ['a']);
  assert.deepEqual(query(data, 'store.book[-1].t'), ['c']); // no leading $
  assert.deepEqual(query(data, '$..price'), [8, 12, 9, 20]);
  assert.deepEqual(query(data, '$.store.book[*].t'), ['a', 'b', 'c']);
  assert.deepEqual(query(data, '$.store.book[1:].t'), ['b', 'c']);
  assert.deepEqual(query(data, '$.store.book[0,2].t'), ['a', 'c']);
  assert.deepEqual(query(data, "$['odd key']"), [1]);
  assert.deepEqual(query(data, '$.store.book[?(@.price < 10)].t'), ['a', 'c']);
  assert.deepEqual(query(data, "$.store.book[?(@.t == 'b')].price"), [12]);
  assert.deepEqual(query(data, '$.store.book[?(@.isbn)].t'), ['c']);
  assert.deepEqual(query(data, '$.store.book[?(@.t =~ /^[ab]$/)].price'), [8, 12]);
  assert.deepEqual(query(data, '$.nope.deeper'), []);
  assert.throws(() => query(data, '$.a['), /Unclosed/);
  assert.throws(() => query(data, '$.a[?(@.x ~~ 1)]'), /Unsupported filter/);
});

test('highlight: JSON keys vs strings, {{variables}} defined / missing, escaping, bracket marks', () => {
  const html = highlight('{"id": "{{uid}}", "n": 1, "x": null, "u": "{{nope}}"}', 'json', { vars: { uid: true } });
  assert.match(html, /<span class="json-key">&quot;id&quot;<\/span>/);
  assert.match(html, /<span class="var var-ok">\{\{uid\}\}<\/span>/);
  assert.match(html, /<span class="var var-missing">\{\{nope\}\}<\/span>/);
  assert.match(html, /<span class="json-num">1<\/span>/);
  assert.match(html, /<span class="json-null">null<\/span>/);
  assert.equal(highlight('<b>&', 'text'), '&lt;b&gt;&amp;');
  assert.match(highlight('const a = 1; // hi', 'js'), /<span class="code-kw">const<\/span>.*<span class="code-comment">\/\/ hi<\/span>/);
  assert.deepEqual(matchBracket('{"a": [1, 2]}', 1), [0, 12]);   // caret just after {
  assert.deepEqual(matchBracket('{"a": [1, 2]}', 12), [6, 11]);  // caret before the inner ]
  assert.deepEqual(matchBracket('abc', 1), []);
  assert.equal(highlight('{x}', 'json', { marks: [0, 2] }), '<span class="bracket-match">{</span>x<span class="bracket-match">}</span>');
  assert.equal(langFor('application/problem+json'), 'json');
  assert.equal(langFor('text/xml'), 'xml');
});

test('binary bodies: detected by content type, previews and file names', () => {
  for (const t of ['image/png', 'application/pdf', 'application/octet-stream', 'application/zip', 'font/woff2']) assert.equal(isBinary(t), true, t);
  for (const t of ['application/json', 'text/html; charset=utf-8', 'image/svg+xml', 'application/vnd.api+json', 'application/xml', undefined]) assert.equal(isBinary(t), false, String(t));
  assert.equal(previewKind({ binary: true, headers: { 'content-type': 'image/png' } }), 'image');
  assert.equal(previewKind({ binary: true, headers: { 'content-type': 'application/pdf' } }), 'pdf');
  assert.equal(previewKind({ headers: { 'content-type': 'text/html' } }), 'html');
  assert.equal(previewKind({ headers: { 'content-type': 'application/json' } }), null);
  assert.equal(bodyFileName({ headers: { 'content-type': 'application/json; charset=utf-8' } }, 'Get user / 42'), 'Get_user_42.json');
  assert.equal(bodyFileName({ binary: true, headers: { 'content-type': 'image/png' } }, ''), 'response.png');
  assert.equal(bodyFileName({ headers: { 'content-type': 'application/hal+json' } }), 'response.json');
});

test('placeRequest: into a folder, before another request, across projects', () => {
  DB.projects = [];
  const p = addProject('P'), q = addProject('Q'), f = addFolder(p, 'F');
  const [a, b, c] = ['a', 'b', 'c'].map((name) => addRequest(p, null, newReq({ name })));
  assert.equal(placeRequest(c.id, { projectId: p.id, beforeId: a.id }), true);
  assert.deepEqual(p.requests.map((r) => r.name), ['c', 'a', 'b']);
  assert.equal(placeRequest(a.id, { projectId: p.id, folderId: f.id }), true);
  assert.deepEqual([p.requests.map((r) => r.name), f.requests.map((r) => r.name)], [['c', 'b'], ['a']]);
  assert.equal(placeRequest(b.id, { projectId: q.id }), true);
  assert.equal(findReq(b.id).p, q);
  assert.equal(placeRequest(b.id, { projectId: 'missing' }), false);
  assert.equal(placeRequest(b.id, { projectId: q.id, beforeId: b.id }), false);
});
