// Requests as code (renderer/app/snippets.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {};
const { SNIPPETS, snippet } = await import('../renderer/app/snippets.js');

const post = { method: 'POST', url: 'https://api.shop.test/orders?x=1', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer abc' }, body: '{"sku":"ABC-1","qty":2,"gift":false,"note":null}', redirect: 'follow', timeoutMs: 10000 };
const get = { method: 'GET', url: 'https://api.shop.test/me', headers: {}, body: '' };

test('every language, for a JSON POST and a bare GET', () => {
  assert.deepEqual(SNIPPETS.map(([id]) => id), ['curl', 'fetch', 'axios', 'python', 'java-restclient', 'java-httpclient', 'csharp']);
  for (const [id] of SNIPPETS) for (const w of [post, get]) { const s = snippet(id, w); assert.ok(s.includes(w.url.split('?')[0]), `${id} has the URL`); }
});

test('fetch and axios send the JSON body as an object', () => {
  const f = snippet('fetch', post);
  assert.match(f, /method: "POST"/); assert.match(f, /"Authorization": "Bearer abc"/); assert.match(f, /body: JSON\.stringify\(\{\n {4}"sku": "ABC-1"/); assert.match(f, /AbortSignal\.timeout\(10000\)/);
  assert.equal(snippet('fetch', get), 'const res = await fetch("https://api.shop.test/me", {\n  method: "GET",\n});\nconsole.log(res.status, await res.text());');
  assert.match(snippet('axios', post), /data: \{\n {4}"sku": "ABC-1",\n {4}"qty": 2/);
});

test('Python: json= with Python literals, Content-Type left to requests', () => {
  const p = snippet('python', post);
  assert.match(p, /payload = \{\n {4}"sku": "ABC-1",\n {4}"qty": 2,\n {4}"gift": False,\n {4}"note": None,\n\}/);
  assert.match(p, /requests\.request\("POST", url, headers=headers, json=payload, timeout=10\)/);
  assert.ok(!p.includes('Content-Type'));
  assert.match(snippet('python', { ...post, headers: { 'Content-Type': 'text/plain' }, body: 'hello' }), /payload = "hello"[\s\S]*data=payload/);
});

test('Java and C#: escaping, text blocks, content type on the content', () => {
  const multi = { ...post, body: '{\n  "a": "say \\"hi\\""\n}' };
  assert.match(snippet('java-restclient', multi), /\.body\("""\n {4}\{\n {6}"a": "say \\\\"hi\\\\""\n {4}\}"""\)/);
  assert.match(snippet('java-httpclient', post), /BodyPublishers\.ofString\("\{\\"sku\\":\\"ABC-1\\"/);
  assert.match(snippet('java-httpclient', post), /Duration\.ofMillis\(10000\)/);
  const cs = snippet('csharp', post);
  assert.match(cs, /new HttpRequestMessage\(HttpMethod\.Post, "https:\/\/api\.shop\.test\/orders\?x=1"\)/);
  assert.match(cs, /new StringContent\(@"\{""sku"":""ABC-1""/);
  assert.match(cs, /Encoding\.UTF8, "application\/json"\)/);
  assert.ok(!cs.includes('TryAddWithoutValidation("Content-Type"'));
  assert.match(snippet('csharp', { ...get, method: 'PURGE' }), /new HttpMethod\("PURGE"\)/);
});
