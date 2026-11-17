// Spec-driven fuzzing (renderer/app/openapi/fuzz.js) and send()'s mutate / sideEffects options it relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mainHttp = require('../main/http.js');
globalThis.window = { electronAPI: { storageSet() {}, historyAppend() {}, doFetch: (o) => mainHttp.proxyFetch(o) } };
const { DB, newReq, addProject, addRequest, findReq, normalizeDB } = await import('../renderer/app/store.js');
const { send } = await import('../renderer/app/http.js');
const { analyzeSpec, matchOperation } = await import('../renderer/app/openapi/spec.js');
const { fuzzCases, judgeCase, withPathParam, fuzzSummary } = await import('../renderer/app/openapi/fuzz.js');

const doc = {
  openapi: '3.0.0', servers: [{ url: '/api' }],
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  security: [{ bearer: [] }],
  paths: { '/shops/{shopId}/orders': { post: {
    parameters: [{ name: 'shopId', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'dryRun', in: 'query', required: true, schema: { type: 'boolean' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }],
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['qty', 'email'], properties: {
      id: { type: 'integer', readOnly: true },
      qty: { type: 'integer', minimum: 1, maximum: 10 },
      email: { type: 'string', format: 'email' },
      note: { type: 'string', maxLength: 20, nullable: true },
      tags: { type: 'array', minItems: 1, items: { type: 'string', enum: ['a', 'b'] } },
      address: { type: 'object', required: ['zip'], properties: { zip: { type: 'string', pattern: '^\\d{5}$' } } },
    } } } } },
    responses: { 201: { content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } } } }, 400: {}, 401: {} },
  } } },
};
const analysis = analyzeSpec(doc);
const op = analysis.operations[0];
const wire = { method: 'POST', url: 'http://h/api/shops/3/orders?dryRun=true&limit=5', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good' },
  body: JSON.stringify({ qty: 2, email: 'a@b.co', note: 'hi', tags: ['a'], address: { zip: '12345' } }) };
const cases = fuzzCases(analysis, op, wire, { shopId: '3' }, { oversized: false, max: 500 });
const find = (where, label) => cases.find((c) => c.where === where && (typeof label === 'string' ? c.label === label : label.test(c.label)));

test('cases cover body fields, parameters, the body as a whole and credentials', () => {
  const expect = [
    ['body.qty', 'missing required field', 'reject'], ['body.qty', 'wrong type (text)', 'reject'], ['body.qty', 'below the minimum 1', 'reject'],
    ['body.qty', 'above the maximum 10', 'reject'], ['body.qty', 'a fraction for an integer', 'reject'], ['body.qty', 'null', 'reject'],
    ['body.email', 'invalid email', 'reject'], ['body.note', 'longer than maxLength 20', 'reject'],
    ['body.tags', 'fewer than minItems 1', 'reject'], ['body.tags[0]', /^not one of "a", "b"/, 'reject'],
    ['body.address.zip', /^doesn't match pattern/, 'reject'], ['body.address.zip', 'missing required field', 'reject'],
    ['body', 'malformed JSON', 'reject'], ['body', 'an unknown extra field', 'reject'], ['body', 'no body', 'reject'], ['body', 'an array instead of an object', 'reject'],
    ['header.Content-Type', 'wrong Content-Type (text/plain)', 'reject'],
    ['query.dryRun', 'missing required parameter', 'reject'], ['query.dryRun', 'wrong type (text)', 'reject'], ['query.limit', 'above the maximum 100', 'reject'],
    ['path.shopId', 'wrong type (text)', 'reject'], ['path.shopId', 'an id that does not exist', 'reject'],
    ['auth', 'no credentials', 'auth'], ['auth', 'an invalid bearer token', 'auth'],
  ];
  for (const [where, label, exp] of expect) {
    const c = find(where, label);
    assert.ok(c, `case ${where}: ${label}`);
    assert.equal(c.expect, exp, `${where}: ${label}`);
  }
  assert.ok(!cases.some((c) => c.where === 'body.id'), 'read-only fields are left alone');
  assert.ok(!find('body.note', 'null'), 'nullable fields may be null');
  assert.ok(cases.some((c) => c.expect === 'any' && /unicode/.test(c.label)), 'odd strings only need to not crash');
});

test('each case changes only its one thing', () => {
  const body = (c) => JSON.parse(c.mutate(structuredClone(wire)).body);
  assert.deepEqual(body(find('body.qty', 'wrong type (text)')), { ...JSON.parse(wire.body), qty: 'not-a-number' });
  assert.ok(!('zip' in body(find('body.address.zip', 'missing required field')).address));
  assert.equal(body(find('body.tags[0]', /^not one of/)).tags[0], 'NOT_AN_ALLOWED_VALUE');
  assert.match(find('query.limit', 'huge number') ? '' : 'ok', /ok/, 'limit has a maximum, so no huge-number case');
  assert.equal(find('query.dryRun', 'missing required parameter').mutate(wire).url, 'http://h/api/shops/3/orders?limit=5');
  assert.equal(find('path.shopId', 'wrong type (text)').mutate(wire).url, 'http://h/api/shops/abc/orders?dryRun=true&limit=5');
  const noAuth = find('auth', 'no credentials').mutate(wire);
  assert.ok(!('Authorization' in noAuth.headers));
  assert.equal(noAuth.body, wire.body);
  assert.equal(find('body', 'no body').mutate(wire).body, '');
  // A huge integer goes out as a bare number, not a string.
  const huge = fuzzCases(analysis, { ...op, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { n: { type: 'integer' } } } } } } }, { ...wire, body: '{"n":1}' }, {}, {}).find((c) => c.where === 'body.n' && c.label === 'huge number');
  assert.equal(huge.mutate({ ...wire, body: '{"n":1}' }).body, '{"n":99999999999999999999}');
});

test('limits: at most `max` cases, and no field takes more than a third of them', () => {
  const few = fuzzCases(analysis, op, wire, { shopId: '3' }, { max: 12 });
  assert.equal(few.length, 12);
  const counts = new Map(); for (const c of few) counts.set(c.where, (counts.get(c.where) || 0) + 1);
  assert.ok(Math.max(...counts.values()) <= 4);
  const big = fuzzCases(analysis, op, wire, { shopId: '3' }, { oversized: true, max: 500 });
  assert.ok(big.some((c) => /64 KB/.test(c.label)));
});

test('path params line up from the end of the URL path', () => {
  assert.equal(withPathParam('https://h/api/v1/pets/7/toys/2?x=1', '/pets/{id}/toys/{toyId}', 'id', 'a b'), 'https://h/api/v1/pets/a%20b/toys/2?x=1');
  assert.equal(withPathParam('/pets/7/', '/pets/{id}', 'id', '8'), '/pets/8/');
  assert.equal(withPathParam('https://h/x', '/a/b/{id}', 'id', '1'), null);
});

test('verdicts', () => {
  const reject = { expect: 'reject' }, any = { expect: 'any' }, auth = { expect: 'auth' };
  const okBody = { headers: { 'content-type': 'application/json' }, body: '{"id":1}' };
  assert.equal(judgeCase(reject, { status: 400, headers: {}, body: '' }, analysis, op).verdict, 'ok');
  assert.equal(judgeCase(reject, { status: 201, ...okBody }, analysis, op).verdict, 'accepted');
  assert.equal(judgeCase(any, { status: 500, headers: {}, body: '' }, analysis, op).verdict, 'server-error');
  assert.equal(judgeCase(any, { status: 201, ...okBody }, analysis, op).verdict, 'ok');
  assert.equal(judgeCase(any, { status: 201, headers: { 'content-type': 'application/json' }, body: '{}' }, analysis, op).verdict, 'off-spec');
  assert.equal(judgeCase(any, { status: 418, headers: {}, body: '' }, analysis, op).verdict, 'off-spec', 'an undocumented status');
  assert.equal(judgeCase(auth, { status: 201, ...okBody }, analysis, op).verdict, 'auth-open');
  assert.equal(judgeCase(auth, { status: 401, headers: {}, body: '' }, analysis, op).verdict, 'ok');
  assert.equal(judgeCase(any, { error: 'ECONNRESET' }, analysis, op).verdict, 'no-response');
  assert.deepEqual(fuzzSummary([{ verdict: 'ok' }, { verdict: 'accepted' }, { verdict: 'off-spec' }]), { cases: 3, ok: 1, fail: 1, warn: 1, byVerdict: { ok: 1, accepted: 1, 'off-spec': 1 } });
});

test('against a buggy server: crashes, accepted bad input and missing auth are found; nothing is stored', async (t) => {
  // Crashes when qty isn't a number; accepts any email; never checks credentials; sets a cookie.
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let b; try { b = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); return res.end(); }
      if (!b || typeof b !== 'object' || Array.isArray(b)) { res.writeHead(400); return res.end(); }
      if (typeof b.qty !== 'number') { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('TypeError: qty.toFixed is not a function'); }
      res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'sess=new' });
      res.end(JSON.stringify({ id: 1, token: 'abc' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(DB, { projects: [], features: [], notes: [], tokenSources: [], settings: { sidebarWidth: 240, openTabs: [], activeTab: null } }); normalizeDB(DB);
  const p = addProject('Shop'); p.cookies = 'sess=old';
  const r = addRequest(p, null, newReq({ method: 'POST', url: `${base}/api/shops/3/orders?dryRun=true`, auth: { type: 'bearer', token: 'good' },
    body: { type: 'json', text: '{"qty":2,"email":"a@b.co"}', form: [] }, chain: [{ k: 'token', v: 'savedToken', on: true }] }));
  const loc = findReq(r.id);
  const baseline = await send(loc, undefined, { sideEffects: false });
  assert.equal(baseline.status, 201);
  const m = matchOperation(analysis, 'POST', baseline.requestData.url);
  const verdicts = {};
  for (const c of fuzzCases(analysis, m.op, baseline.requestData, m.pathParams, { oversized: false })) {
    const res = await send(loc, undefined, { sideEffects: false, mutate: c.mutate });
    verdicts[`${c.where}: ${c.label}`] = judgeCase(c, res, analysis, m.op).verdict;
  }
  assert.equal(verdicts['body.qty: wrong type (text)'], 'server-error');
  assert.equal(verdicts['body.email: invalid email'], 'accepted');
  assert.equal(verdicts['auth: no credentials'], 'auth-open');
  assert.equal(verdicts['body: malformed JSON'], 'ok');
  assert.equal(p.cookies, 'sess=old', 'cookies from fuzz sends are not kept');
  assert.equal(p.envs.length, 0, 'extract rules did not run');
  // A normal send does store them.
  await send(loc);
  assert.equal(p.cookies, 'sess=new');
  assert.equal(p.envs[0].vars.find((v) => v.k === 'savedToken').v, 'abc');
});
