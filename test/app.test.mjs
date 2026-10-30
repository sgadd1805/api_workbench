// Main window logic that doesn't need a DOM: cURL, request building, cookies, store helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, parseCurl, toCurl } from '../renderer/app/curl.js';
import { buildRequest, mergeCookies, extractValues, b64utf8 } from '../renderer/app/http.js';
import { normalizeDB, setRequestUrl, effectiveAuth, projectAuthFromForm, projectAuthToForm, newReq, AI_PROMPT_DEFAULTS } from '../renderer/app/store.js';
import { assertionFailures } from '../renderer/app/assertions.js';

test('tokenize: quoting rules', () => {
  assert.deepEqual(tokenize(`a 'b c' "d \\"e\\" \\n" f\\ g`), ['a', 'b c', 'd "e" \\n', 'f g']);
  assert.deepEqual(tokenize(`$'it\\'s\\u0021\\n\\x41'`), ["it's!\nA"]);
  assert.deepEqual(tokenize(`curl \\\n  -X POST`), ['curl', '-X', 'POST']);
  assert.deepEqual(tokenize(`''`), ['']);
});

test('parseCurl: Chrome "Copy as cURL" with $-quoted body', () => {
  const r = parseCurl(`curl 'https://x.test/api' -H 'content-type: application/json' --data-raw $'{"a":"it\\'s"}'`);
  assert.equal(r.url, 'https://x.test/api');
  assert.equal(r.method, 'POST');
  assert.equal(r.body.text, `{"a":"it's"}`);
  assert.equal(r.name, '/api');
});

test('parseCurl: value options are not taken as the URL', () => {
  const r = parseCurl(`curl -A "Mozilla 5" -o out.txt https://x.test/u`);
  assert.equal(r.url, 'https://x.test/u');
  assert.deepEqual(r.headers, [{ k: 'User-Agent', v: 'Mozilla 5', on: true }]);
});

test('parseCurl: -d joins with & and defaults to a form body', () => {
  const r = parseCurl(`curl https://x.test -d a=1 -d b=2`);
  assert.equal(r.body.text, 'a=1&b=2');
  assert.ok(r.headers.some((h) => h.k === 'Content-Type' && h.v === 'application/x-www-form-urlencoded'));
});

test('parseCurl: -G, -XPUT, -u, --data-urlencode', () => {
  assert.equal(parseCurl(`curl -G https://x.test/s -d q=1`).url, 'https://x.test/s?q=1');
  assert.equal(parseCurl(`curl -XPUT https://x.test`).method, 'PUT');
  assert.deepEqual(parseCurl(`curl -u me:p:w https://x.test`).auth, { type: 'basic', user: 'me', pass: 'p:w' });
  assert.equal(parseCurl(`curl https://x.test --data-urlencode 'q=a b&c'`).body.text, 'q=a%20b%26c');
});

const loc = (r, p = {}, f = null) => ({ p: { auth: { type: 'none' }, cookies: '', ...p }, f, r: { ...newReq(), ...r } });

test('buildRequest: header names are case-insensitive; auth overrides', () => {
  const req = buildRequest(loc({ headers: [{ k: 'authorization', v: 'x', on: true }, { k: 'X-Off', v: '1', on: false }] },
    { auth: { type: 'basic', user: 'zoë', pass: 'π' }, cookies: 'a=1' }));
  assert.deepEqual(Object.keys(req.headers), ['Authorization', 'Cookie']);
  assert.equal(req.headers.Authorization, 'Basic ' + b64utf8('zoë:π'));
});

test('buildRequest: explicit Cookie header wins over the jar; GET drops the body', () => {
  const req = buildRequest(loc({ headers: [{ k: 'cookie', v: 'mine=1', on: true }], body: { type: 'raw', text: 'x' } }, { cookies: 'jar=1' }));
  assert.deepEqual(req.headers, { cookie: 'mine=1' });
  assert.equal(req.body, '');
});

test('effectiveAuth: request → folder → project', () => {
  const p = { auth: { type: 'bearer', token: 'P' } }, f = { auth: { type: 'inherit' } };
  assert.equal(effectiveAuth({ p, f, r: { auth: { type: 'inherit' } } }).token, 'P');
  assert.equal(effectiveAuth({ p, f: { auth: { type: 'bearer', token: 'F' } }, r: { auth: { type: 'inherit' } } }).token, 'F');
  assert.equal(effectiveAuth({ p, f, r: { auth: { type: 'none' } } }).type, 'none');
});

test('mergeCookies: adds, replaces and expires', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  let jar = mergeCookies('', ['sid=abc; Path=/; HttpOnly', 'theme=dark; Expires=Thu, 01 Jan 2099 00:00:00 GMT', 'old=1'], now);
  assert.equal(jar, 'sid=abc; theme=dark; old=1');
  jar = mergeCookies(jar, ['sid=; Max-Age=0', 'old=; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'theme=light'], now);
  assert.equal(jar, 'theme=light');
});

test('extractValues: body paths, headers, targets', () => {
  const res = { body: '{"data":{"token":"t1","items":[{"id":7}]}}', headers: { 'x-token': 'h1' } };
  const rules = [
    { k: 'data.token', v: '', on: true }, { k: 'body.data.items.0.id', v: 'itemId', on: true },
    { k: 'header.x-token', v: 'hdr', on: true }, { k: 'missing', v: 'x', on: true }, { k: 'data.token', v: 'off', on: false },
  ];
  assert.deepEqual(extractValues(rules, res), [
    { path: 'data.token', to: 'bearer', value: 't1' }, { path: 'body.data.items.0.id', to: 'itemId', value: '7' }, { path: 'header.x-token', to: 'hdr', value: 'h1' }]);
  assert.deepEqual(extractValues([{ k: 'a', v: '', on: true }], { body: 'not json' }), []);
});

test('toCurl round-trips through parseCurl', () => {
  const req = { method: 'POST', url: 'https://x.test/a?b=1', headers: { 'Content-Type': 'application/json', 'X-Q': "it's" }, body: '{"k":"v"}' };
  const back = parseCurl(toCurl(req));
  assert.equal(back.method, 'POST');
  assert.equal(back.url, req.url);
  assert.equal(back.body.text, req.body);
  assert.deepEqual(back.headers.map((h) => [h.k, h.v]), Object.entries(req.headers));
});

test('setRequestUrl: auto names follow the URL, custom names stay', () => {
  const r = newReq();
  for (const u of ['h', 'ht', 'https://x.test/abc']) setRequestUrl(r, u);
  assert.equal(r.name, 'https://x.test/abc');
  r.name = 'My call'; setRequestUrl(r, 'https://y.test');
  assert.equal(r.name, 'My call');
});

test('normalizeDB fills missing fields', () => {
  const db = normalizeDB({ projects: [{ id: 'p', requests: [{ id: 'r' }], folders: [{ id: 'f' }] }] });
  assert.deepEqual(db.settings, { layout: { split: 'row', ratio: 0.45, sideOpen: false, sideTab: 'spec', sideWidth: 400, session: false }, aiPrompt: AI_PROMPT_DEFAULTS, theme: 'dark', zoom: 1 });
  // Saved prompt choices are kept; sections added later default to on.
  assert.deepEqual(normalizeDB({ projects: [], settings: { aiPrompt: { logs: false, instructions: 'Be brief' } } }).settings.aiPrompt, { ...AI_PROMPT_DEFAULTS, logs: false, instructions: 'Be brief' });
  assert.deepEqual([db.features, db.notes], [[], []]);
  assert.deepEqual(db.projects[0].folders[0].requests, []);
  assert.equal(db.projects[0].requests[0].method, 'GET');
  assert.deepEqual(db.projects[0].requests[0].headers, []);
});

test('project auth form fields', () => {
  assert.deepEqual(projectAuthFromForm('basic', 'u:p:q'), { type: 'basic', user: 'u', pass: 'p:q' });
  assert.equal(projectAuthToForm({ type: 'basic', user: 'u', pass: 'p' }), 'u:p');
  assert.deepEqual(projectAuthFromForm('none', 'x'), { type: 'none' });
});

test('assertionFailures: failed and errored assertions become runner failures', () => {
  assert.deepEqual(assertionFailures([{ expr: 'status === 200', ok: true }, { expr: 'body.ok', ok: false }, { expr: 'nope(', ok: false, err: 'Unexpected token' }]),
    ['assertion failed: body.ok', 'assertion failed: nope( (Unexpected token)']);
  assert.deepEqual(assertionFailures(undefined), []);
});
