// Dynamic variables ({{$uuid}}, {{$isoNow+1d}} …) and their use in requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { electronAPI: { storageSet() {} } };
const { parseDynamic, dynamicValue, isDynamic, DYNAMIC_VARS } = await import('../renderer/shared/dynvars.js');
const { resolve } = await import('../renderer/app/vars.js');
const { highlight } = await import('../renderer/shared/highlight.js');
const { DB, addProject, addEnv, addRequest, newReq } = await import('../renderer/app/store.js');
const { buildRequest } = await import('../renderer/app/http.js');

test('parse: names, aliases, arguments, offsets; unknown names are not dynamic', () => {
  assert.deepEqual(parseDynamic('$isoNow+1d'), { name: 'isoNow', args: [], offsetMs: 864e5 });
  assert.deepEqual(parseDynamic('$randomInt:1:6'), { name: 'randomInt', args: ['1', '6'], offsetMs: 0 });
  assert.equal(parseDynamic('$guid').name, 'uuid');
  assert.equal(parseDynamic('$date-2w').offsetMs, -2 * 6048e5);
  assert.equal(isDynamic('$nope'), false); assert.equal(isDynamic('uuid'), false);
  assert.ok(DYNAMIC_VARS.length >= 18 && DYNAMIC_VARS.every((d) => d.name.startsWith('$') && d.description));
});

test('values: formats, ranges, offsets from a fixed time', () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);
  assert.match(dynamicValue('$uuid'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(dynamicValue('$timestamp', null, now), String(now / 1000));
  assert.equal(dynamicValue('$isoNow+1d', null, now), '2026-10-30T12:00:00.000Z');
  assert.equal(dynamicValue('$date-7d', null, now), '2026-10-22');
  for (let i = 0; i < 50; i++) { const v = +dynamicValue('$randomInt:1:6'); assert.ok(v >= 1 && v <= 6 && Number.isInteger(v)); }
  assert.match(dynamicValue('$randomEmail'), /^[a-z]+\.[a-z]+\d+@example\.com$/);
  assert.equal(dynamicValue('$randomAlphaNumeric:12').length, 12);
  assert.equal(dynamicValue('$randomWords:4').split(' ').length, 4);
  assert.equal(dynamicValue('$nope'), undefined);
});

test('resolve: same expression → same value per send, unknown $names reported, env vars win', () => {
  const missing = new Set(), dyn = new Map();
  const a = resolve('{{$uuid}}|{{ $uuid }}|{{$randomInt:1:1000000}}', {}, missing, dyn);
  const [u1, u2] = a.split('|');
  assert.equal(u1, u2);
  assert.equal(resolve('{{$uuid}}', {}, missing, dyn), u1);
  assert.notEqual(resolve('{{$uuid}}', {}), u1); // a new send (new map) → new value
  resolve('{{$typo}}', {}, missing);
  assert.deepEqual([...missing], ['$typo']);
  assert.equal(resolve('{{$uuid}}', { $uuid: 'fixed' }), 'fixed');
  assert.match(highlight('{{$isoNow+1d}} {{base}}', 'text', { vars: {} }), /var var-dyn">\{\{\$isoNow\+1d\}\}.*var var-missing">\{\{base\}\}/);
});

test('buildRequest: one value per expression across URL, headers and body', () => {
  DB.projects = [];
  const p = addProject('P'); const env = addEnv(p, 'dev'); env.vars.push({ k: 'base', v: 'http://x', on: true });
  const r = addRequest(p, null, newReq({ method: 'POST', url: '{{base}}/orders/{{$uuid}}', headers: [{ k: 'Idempotency-Key', v: '{{$uuid}}', on: true }], body: { type: 'json', text: '{"id":"{{$uuid}}","due":"{{$date+30d}}"}', form: [] } }));
  const w = buildRequest({ p, f: null, r });
  const id = w.url.split('/').pop();
  assert.equal(w.headers['Idempotency-Key'], id);
  assert.equal(JSON.parse(w.body).id, id);
  assert.match(JSON.parse(w.body).due, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(w.missingVars, []);
  assert.notEqual(buildRequest({ p, f: null, r }).url.split('/').pop(), id);
});
