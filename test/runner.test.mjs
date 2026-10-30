// Collection runner, script request edits, environment override, and load-test statistics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

globalThis.window = { electronAPI: { storageSet() {}, historyAppend() {}, doFetch: async (req) => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: JSON.stringify({ url: req.url, auth: req.headers.Authorization || null }) }) } };
const { DB, S, newReq, addProject, addRequest, addEnv } = await import('../renderer/app/store.js');
const { parseCsv, judge, runCollection, summarize, toJUnit } = await import('../renderer/app/runner.js');
const { applyRequestEdits } = await import('../renderer/app/scripts.js');
const { send, buildRequest } = await import('../renderer/app/http.js');
const require = createRequire(import.meta.url);
const load = require('../main/load.js');

test('parseCsv: header row, quotes, escaped quotes, CRLF, blank lines', () => {
  assert.deepEqual(parseCsv('id,name,note\r\n1,Rex,"a, b"\r\n\r\n2,"Fido ""the dog""",\n'), [
    { id: '1', name: 'Rex', note: 'a, b' }, { id: '2', name: 'Fido "the dog"', note: '' }]);
  assert.deepEqual(parseCsv('only,header\n'), []);
  assert.deepEqual(parseCsv(''), []);
});

test('judge: assertions, script tests, spec errors, plain HTTP status', () => {
  const loc = (assertions = []) => ({ r: { assertions } });
  assert.deepEqual(judge(loc(), { status: 200, body: '' }), { passed: true, failures: [] });
  assert.deepEqual(judge(loc(), { status: 500, body: '' }).failures, ['HTTP 500']);
  // Assertion results come from the sandbox (res.assertionResults); having assertions means they decide.
  assert.equal(judge(loc(['status === 404']), { status: 404, body: '', assertionResults: [{ expr: 'status === 404', ok: true }] }).passed, true);
  assert.deepEqual(judge(loc(['status === 200']), { status: 404, body: '', assertionResults: [{ expr: 'status === 200', ok: false }] }).failures, ['assertion failed: status === 200']);
  assert.deepEqual(judge(loc(), { status: 200, body: '', scriptTests: [{ name: 'id set', ok: false, error: 'expected 1' }] }).failures, ['test failed: id set — expected 1']);
  assert.deepEqual(judge(loc(), { status: 200, body: '', validation: { request: [], response: [{ level: 'error', where: 'body.id', message: 'is required' }, { level: 'warning', where: 'x', message: 'y' }] } }).failures, ['spec: body.id is required']);
  assert.deepEqual(judge(loc(), { error: 'ECONNREFUSED' }).failures, ['ECONNREFUSED']);
});

test('runCollection: data rows as variables, setNextRequest jumps / stops, stop on failure', async () => {
  const mk = (name) => ({ p: {}, f: null, r: { id: name, name, method: 'GET', url: '/' + name, assertions: [] } });
  const locs = [mk('login'), mk('list'), mk('create'), mk('cleanup')];
  const calls = [];
  // login → (skip list) create → cleanup, then stop the iteration
  const sendFake = async (loc, vars) => {
    calls.push(`${loc.r.name}:${vars.user || '-'}`);
    const next = loc.r.name === 'login' ? 'create' : loc.r.name === 'cleanup' ? null : undefined;
    return { status: loc.r.name === 'create' && vars.user === 'bad' ? 500 : 200, body: '', time: 1, next };
  };
  const results = await runCollection(locs, sendFake, { rows: [{ user: 'ann' }, { user: 'bad' }] });
  assert.deepEqual(calls, ['login:ann', 'create:ann', 'cleanup:ann', 'login:bad', 'create:bad', 'cleanup:bad']);
  assert.deepEqual(summarize(results), { total: 6, passed: 5, failed: 1, time: 6 });
  assert.equal(results[4].iteration, 2);
  calls.length = 0;
  await runCollection(locs, sendFake, { rows: [{ user: 'bad' }, { user: 'ann' }], stopOnFailure: true });
  assert.deepEqual(calls, ['login:bad', 'create:bad']);
  calls.length = 0;
  let stop = false;
  await runCollection(locs, async (l, v) => { stop = true; return sendFake(l, v); }, { iterations: 3, shouldStop: () => stop });
  assert.equal(calls.length, 1);
  const xml = toJUnit('Pets & co', results);
  assert.match(xml, /<testsuite name="Pets &amp; co" tests="6" failures="1">/);
  assert.match(xml, /<failure message="HTTP 500">/);
});

test('applyRequestEdits: script edits win over the rebuilt request, header removals replay', () => {
  const before = { url: 'u1', method: 'GET', body: '', headers: { A: '1', B: '2' } };
  const after = { url: 'u1', method: 'POST', body: 'x', headers: { A: '1', C: '3' } };
  const rebuilt = { url: 'u2', method: 'GET', body: '', headers: { A: '1', B: '2', D: '4' } };
  assert.deepEqual(applyRequestEdits(before, after, rebuilt), { url: 'u2', method: 'POST', body: 'x', headers: { A: '1', C: '3', D: '4' } });
});

test('send with an environment override and runner variables', async () => {
  DB.projects = []; S.tabs = [];
  const p = addProject('P'); p.correlation = false;
  const dev = addEnv(p, 'dev'); dev.vars.push({ k: 'base', v: 'https://dev.test', on: true });
  const prod = addEnv(p, 'prod'); prod.vars.push({ k: 'base', v: 'https://prod.test', on: true });
  p.activeEnv = dev.id;
  const r = addRequest(p, null, newReq({ url: '{{base}}/users/{{id}}' }));
  const loc = { p, f: null, r };
  assert.equal(JSON.parse((await send(loc, undefined, { env: prod, vars: { id: '7' } })).body).url, 'https://prod.test/users/7');
  assert.equal(JSON.parse((await send(loc)).body).url, 'https://dev.test/users/{{id}}');
  assert.equal(buildRequest(loc, { env: prod }).url, 'https://prod.test/users/{{id}}');
});

test('load test: percentiles, statuses, histogram; a real run against a local server', async (t) => {
  assert.equal(load.percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 50), 50);
  assert.equal(load.percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95), 100);
  const s = load.summarize([{ ms: 10, status: 200, at: 0 }, { ms: 30, status: 200, at: 10 }, { ms: 20, status: 503, at: 20 }, { ms: 5, error: 'ECONNRESET', at: 30 }], 1000);
  assert.deepEqual([s.count, s.ok, s.failed, s.rps, s.min, s.max, s.p50], [4, 2, 2, 4, 10, 30, 20]);
  assert.deepEqual([s.statuses, s.errors], [{ 200: 2, 503: 1 }, { ECONNRESET: 1 }]);
  assert.equal(s.histogram.reduce((n, b) => n + b.count, 0), 3);
  let n = 0;
  const server = http.createServer((_q, res) => { n++; setTimeout(() => res.end(n % 10 ? 'ok' : 'x'), 2); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const progress = [];
  const stats = await load.run({ id: 'L1', request: { url: `http://127.0.0.1:${server.address().port}/`, method: 'GET', headers: {} }, total: 60, concurrency: 6 }, (p) => progress.push(p));
  assert.equal(stats.count, 60);
  assert.equal(n, 60);
  assert.equal(stats.statuses[200], 60);
  assert.ok(stats.p50 > 0 && stats.p99 >= stats.p50 && stats.rps > 0);
  assert.ok(progress.at(-1).final);
});
