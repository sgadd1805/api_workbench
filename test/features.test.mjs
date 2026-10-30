// Variables, params, body types, request ops, environments, collections and capture import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeVars, resolve, encodeKeepingVars } from '../renderer/app/vars.js';
import { splitUrl, parseQuery, withQuery, queryRows } from '../renderer/app/query.js';
import { buildRequest } from '../renderer/app/http.js';
import { toCurl, parseCurl } from '../renderer/app/curl.js';
import {
  DB, S, newReq, addProject, addFolder, addRequest, findReq, duplicateRequest, deleteRequest, deleteFolder, moveRequest,
  addEnv, deleteEnv, setVar, activeEnv, normalizeRequest,
} from '../renderer/app/store.js';
import { exportNative, exportPostman, importCollection } from '../renderer/app/collection.js';
import { requestFromCapture } from '../renderer/app/capture.js';
import { activateTab, closeTab, moveTab, restoreTabs, activeTab, tabFor } from '../renderer/app/store.js';

// Store mutations schedule a save through the preload API.
const appended = [];
globalThis.window = { electronAPI: { storageSet() {}, historyAppend: (e) => appended.push(e), historyDelete() {}, historyClear() {} } };
const { recordHistory, runsFor, historyEntries, historyEntry, deleteHistoryEntry, clearHistory, matchesQuery, groupByDay, entryFromSend } = await import('../renderer/app/history.js');

const reset = () => { DB.projects = []; S.req = null; S.tabs = []; };

test('variables', () => {
  const p = { envs: [{ id: 'e1', vars: [{ k: 'host', v: 'x.test', on: true }, { k: 'off', v: '1', on: false }] }], activeEnv: 'e1' };
  const vars = activeVars(p);
  assert.deepEqual(vars, { host: 'x.test' });
  const missing = new Set();
  assert.equal(resolve('https://{{host}}/{{ off }}/{{nope}}', vars, missing), 'https://x.test/{{ off }}/{{nope}}');
  assert.deepEqual([...missing], ['off', 'nope']);
  assert.deepEqual(activeVars({ envs: [], activeEnv: null }), {});
  assert.equal(encodeKeepingVars('a b {{v}}&'), 'a%20b%20{{v}}%26');
});

test('query rows ⇄ URL (variables survive)', () => {
  assert.deepEqual(splitUrl('{{base}}/p?a=1#h'), { base: '{{base}}/p', query: 'a=1', hash: '#h' });
  assert.deepEqual(parseQuery('a=1&b&c=x%20y+z'), [{ k: 'a', v: '1' }, { k: 'b', v: '' }, { k: 'c', v: 'x y z' }]);
  assert.equal(withQuery('{{base}}/p?a=1#h', [{ k: 'a', v: '{{id}}' }, { k: 'q', v: 'a&b' }, { k: '', v: 'dropped' }]), '{{base}}/p?a={{id}}&q=a%26b#h');
  assert.equal(withQuery('https://x/p?a=1', []), 'https://x/p');
  assert.deepEqual(queryRows('https://x/p'), []);
});

const loc = (fields, p = {}) => {
  const proj = { auth: { type: 'none' }, cookies: '', envs: [], activeEnv: null, ...p };
  return { p: proj, f: null, r: newReq(fields) };
};

test('buildRequest: variables everywhere, body types, options', () => {
  const env = { id: 'e', vars: [{ k: 'base', v: 'https://x.test', on: true }, { k: 'tok', v: 'T', on: true }, { k: 'name', v: 'zoë', on: true }] };
  const json = buildRequest(loc({ method: 'POST', url: '{{base}}/u', headers: [{ k: 'X-{{name}}', v: '{{tok}}', on: true }],
    body: { type: 'json', text: '{"n":"{{name}}"}' }, auth: { type: 'bearer', token: '{{tok}}' }, options: { timeoutSec: 5, followRedirects: false } },
    { envs: [env], activeEnv: 'e' }));
  assert.equal(json.url, 'https://x.test/u');
  assert.deepEqual(json.headers, { 'X-zoë': 'T', Authorization: 'Bearer T', 'Content-Type': 'application/json' });
  assert.equal(json.body, '{"n":"zoë"}');
  assert.equal(json.timeoutMs, 5000);
  assert.equal(json.redirect, 'manual');
  assert.deepEqual(json.missingVars, []);

  const form = buildRequest(loc({ method: 'POST', url: 'https://x', headers: [{ k: 'content-type', v: 'text/x', on: true }],
    body: { type: 'form', form: [{ k: 'a b', v: '1&2', on: true }, { k: 'off', v: 'x', on: false }] } }));
  assert.equal(form.body, 'a%20b=1%262');
  assert.deepEqual(form.headers, { 'content-type': 'text/x' }); // explicit header wins

  const missing = buildRequest(loc({ url: '{{nope}}/x' }));
  assert.deepEqual(missing.missingVars, ['nope']);
  assert.equal(missing.redirect, 'follow');
  assert.equal(missing.timeoutMs, 60000);
});

test('toCurl carries redirect and timeout options', () => {
  const curl = toCurl({ method: 'GET', url: 'https://x', headers: {}, body: '', redirect: 'follow', timeoutMs: 5000 });
  assert.match(curl, /-L --max-time 5/);
  assert.equal(parseCurl(curl).url, 'https://x');
});

test('request rename/duplicate/move/delete', () => {
  reset();
  const p = addProject('P'), f = addFolder(p, 'F');
  const r = addRequest(p, null, newReq({ name: 'one', url: 'https://x' }));
  addRequest(p, null, newReq({ name: 'two' }));
  const copy = duplicateRequest(r.id);
  assert.deepEqual(p.requests.map((x) => x.name), ['one', 'one copy', 'two']);
  assert.notEqual(copy.id, r.id);
  copy.headers.push({ k: 'a', v: 'b', on: true });
  assert.equal(r.headers.length, 0); // deep copy
  moveRequest(copy.id, f.id);
  assert.equal(findReq(copy.id).f, f);
  moveRequest(copy.id, '');
  assert.equal(findReq(copy.id).f, null);
  S.req = r; deleteRequest(r.id);
  assert.equal(findReq(r.id), null);
  assert.equal(S.req, null);
});

test('environments and setVar', () => {
  reset();
  const p = addProject('P');
  setVar(p, 'token', 'a'); // no env yet → creates Default
  assert.equal(activeEnv(p).name, 'Default');
  setVar(p, 'token', 'b');
  assert.deepEqual(activeEnv(p).vars, [{ k: 'token', v: 'b', on: true }]);
  const e2 = addEnv(p, 'staging');
  assert.equal(p.activeEnv, activeEnv(p).id); // first env stays active
  deleteEnv(p, p.activeEnv);
  assert.equal(p.activeEnv, e2.id);
});

test('normalizeRequest migrates old chain rules and adds options', () => {
  const r = normalizeRequest({ chain: [{ path: 'data.token' }, { from: 'body.x' }] });
  assert.deepEqual(r.chain, [{ k: 'data.token', v: 'bearer', on: true }, { k: 'x', v: 'bearer', on: true }]);
  assert.deepEqual(r.options, { timeoutSec: 60, followRedirects: true });
  assert.deepEqual(r.body.form, []);
});

test('history: records sends and errors, skips cancels, caps at 200, feeds runsFor', () => {
  clearHistory(); appended.length = 0;
  const l = { p: { id: 'p1' }, r: { id: 'req1', name: 'Echo', method: 'GET', url: '{{base}}/e' } };
  const ok = (body) => ({ status: 200, statusText: 'OK', headers: { a: '1' }, body, time: 5, requestData: { method: 'GET', url: 'https://x/e', headers: { H: 'v' }, body: '' } });
  for (let i = 0; i < 12; i++) recordHistory(l, ok(String(i)));
  recordHistory(l, { error: 'Timed out after 1 s', requestData: { method: 'GET', url: 'https://x/e', headers: {}, body: '' } });
  recordHistory(l, { error: 'Cancelled', cancelled: true });
  assert.equal(historyEntries().length, 13);
  assert.equal(appended.length, 13);
  const latest = historyEntries()[0];
  assert.deepEqual([latest.error, latest.response, latest.url, latest.reqName], ['Timed out after 1 s', null, 'https://x/e', 'Echo']);
  const runs = runsFor('req1');
  assert.equal(runs.length, 10);
  assert.equal(runs[0].body, '11'); // errors are skipped
  assert.ok(runs[0].at);
  assert.deepEqual(runsFor('other'), []);
  for (let i = 0; i < 250; i++) recordHistory(l, ok('x'));
  assert.equal(historyEntries().length, 200);
  const id = historyEntries()[0].id;
  assert.ok(historyEntry(id));
  deleteHistoryEntry(id);
  assert.equal(historyEntry(id), null);
  clearHistory();
  assert.equal(historyEntries().length, 0);
});

test('history: entryFromSend falls back to the stored request when nothing was sent', () => {
  const e = entryFromSend({ p: { id: 'p' }, r: { id: 'r', name: 'n', method: 'POST', url: 'u' } }, { error: 'bad URL', requestData: null }, 1000);
  assert.deepEqual([e.method, e.url, e.at, e.error, e.response], ['POST', 'u', 1000, 'bad URL', null]);
});

test('history search and day groups', () => {
  const e = { method: 'POST', url: 'https://api.x/users?id=7', response: { status: 404 }, reqName: 'Create user', error: null };
  assert.ok(matchesQuery(e, 'post users'));
  assert.ok(matchesQuery(e, '404'));
  assert.ok(matchesQuery(e, 'CREATE'));
  assert.ok(!matchesQuery(e, 'get'));
  assert.ok(matchesQuery({ ...e, response: null, error: 'Timed out' }, 'error timed'));
  const now = new Date(2026, 9, 28, 15, 0).getTime(), H = 3600000;
  const groups = groupByDay([{ at: now - H }, { at: now - 2 * H }, { at: now - 24 * H }, { at: now - 72 * H }, { at: now - 400 * 24 * H }], now);
  assert.deepEqual(groups.map((g) => [g.label.split(' ')[0].replace(',', ''), g.entries.length]).slice(0, 2), [['Today', 2], ['Yesterday', 1]]);
  assert.equal(groups.length, 4);
  assert.match(groups[3].label, /2025/); // other years show the year
});

function sampleProject() {
  reset();
  const p = addProject('Sample');
  p.cookies = 'sid=secret';
  p.auth = { type: 'bearer', token: '{{tok}}' };
  const env = addEnv(p, 'dev'); env.vars.push({ k: 'base', v: 'https://x.test', on: true });
  const f = addFolder(p, 'Users');
  addRequest(p, f, newReq({ name: 'Create', method: 'POST', url: '{{base}}/users', headers: [{ k: 'X-A', v: '1', on: true }, { k: 'X-Off', v: '0', on: false }],
    body: { type: 'json', text: '{"a":1}' }, auth: { type: 'basic', user: 'u', pass: 'p' } }));
  addRequest(p, null, newReq({ name: 'Login', method: 'POST', url: '{{base}}/login', body: { type: 'form', form: [{ k: 'user', v: 'me', on: true }] } }));
  return p;
}

test('native export/import round-trips with fresh ids and no cookies', () => {
  const p = sampleProject();
  const back = importCollection(exportNative(p, { includeSecrets: true }));
  assert.notEqual(back.id, p.id);
  assert.equal(back.cookies, '');
  assert.equal(back.envs[0].name, 'dev');
  assert.equal(back.activeEnv, back.envs[0].id);
  assert.equal(back.folders[0].requests[0].body.text, '{"a":1}');
  assert.notEqual(back.folders[0].requests[0].id, p.folders[0].requests[0].id);
});

test('Postman export → import round-trips the important parts', () => {
  const p = sampleProject();
  const pm = JSON.parse(exportPostman(p, { includeSecrets: true }));
  assert.match(pm.info.schema, /v2\.1\.0/);
  assert.deepEqual(pm.variable, [{ key: 'base', value: 'https://x.test' }]);
  const back = importCollection(JSON.stringify(pm));
  assert.equal(back.name, 'Sample');
  assert.deepEqual(back.auth, { type: 'bearer', token: '{{tok}}' });
  const create = back.folders[0].requests[0];
  assert.equal(back.folders[0].name, 'Users');
  assert.equal(create.url, '{{base}}/users');
  assert.deepEqual(create.headers, [{ k: 'X-A', v: '1', on: true }, { k: 'X-Off', v: '0', on: false }]);
  assert.deepEqual(create.body.type, 'json');
  assert.deepEqual(create.auth, { type: 'basic', user: 'u', pass: 'p' });
  assert.deepEqual(back.requests[0].body.form, [{ k: 'user', v: 'me', on: true }]);
  assert.equal(back.envs[0].vars[0].v, 'https://x.test');
});

test('Postman import: nested folders, v2.0 auth, url objects', () => {
  const p = importCollection(JSON.stringify({
    info: { name: 'PM', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' },
    item: [
      { name: 'Top', item: [{ name: 'Inner', item: [{ name: 'Deep', request: { method: 'get', url: { raw: 'https://x/deep' } } }] }] },
      { name: 'Root', request: { method: 'POST', url: 'https://x/r', auth: { type: 'bearer', bearer: { token: 'v20' } }, body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }] } } },
      { name: 'Str', request: 'https://x/plain' },
    ],
  }));
  assert.deepEqual(p.folders.map((f) => f.name), ['Top / Inner']);
  assert.equal(p.folders[0].requests[0].method, 'GET');
  assert.equal(p.folders[0].requests[0].url, 'https://x/deep');
  assert.deepEqual(p.requests[0].auth, { type: 'bearer', token: 'v20' });
  assert.equal(p.requests[0].body.type, 'form');
  assert.equal(p.requests[1].url, 'https://x/plain');
  assert.throws(() => importCollection('{"hello":1}'), /Unrecognised/);
  assert.throws(() => importCollection('nope'), /Not a JSON/);
});

test('requestFromCapture', () => {
  const r = requestFromCapture({
    method: 'POST', url: 'https://api.x/v1/items?x=1', status: 200, mimeType: 'application/json', postData: '{"a":1}',
    headers: [{ name: ':authority', value: 'api.x' }, { name: 'Content-Length', value: '7' }, { name: 'Accept', value: '*/*' }, { name: 'Authorization', value: 'Bearer t' }],
  });
  assert.equal(r.name, '/v1/items?x=1');
  assert.deepEqual(r.headers.map((h) => h.k), ['Accept', 'Authorization']);
  assert.equal(r.body.type, 'json');
  assert.equal(requestFromCapture({ method: 'GET', url: 'u', status: 0, headers: [], postData: '', mimeType: '' }).body.type, 'none');
});

test('request tabs: open order, neighbours on close, delete closes tabs, restore', () => {
  reset();
  const p = addProject('P'), f = addFolder(p, 'F');
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((name) => addRequest(p, name === 'd' ? f : null, newReq({ name })));
  activateTab(a.id); activateTab(b.id); activateTab(a.id); activateTab(c.id); // c opens right after the active a
  assert.deepEqual(S.tabs.map((t) => t.id), [a.id, c.id, b.id]);
  assert.equal(S.req, c);
  activateTab(a.id); // re-activating an open tab doesn't duplicate it
  assert.equal(S.tabs.length, 3);
  tabFor(b.id).unseen = true; activateTab(b.id);
  assert.equal(activeTab().unseen, false);
  closeTab(b.id); // last tab active → left neighbour
  assert.equal(S.req, c);
  activateTab(a.id); closeTab(a.id); // first tab active → right neighbour
  assert.equal(S.req, c);
  activateTab(d.id); activateTab(a.id);
  moveTab(a.id, 0);
  assert.deepEqual(S.tabs.map((t) => t.id), [a.id, c.id, d.id]);
  deleteRequest(a.id); // deleting the active request closes its tab
  assert.deepEqual(S.tabs.map((t) => t.id), [c.id, d.id]);
  assert.equal(S.req, c);
  deleteFolder(p, f.id);
  assert.deepEqual(S.tabs.map((t) => t.id), [c.id]);
  assert.deepEqual(DB.settings.openTabs, [c.id]);
  assert.equal(DB.settings.activeTab, c.id);
  // restore drops ids of requests that no longer exist
  DB.settings.openTabs = ['gone', c.id, b.id]; DB.settings.activeTab = b.id;
  S.tabs = []; S.req = null;
  restoreTabs();
  assert.deepEqual(S.tabs.map((t) => t.id), [c.id, b.id]);
  assert.equal(S.req, b);
  closeTab(b.id); closeTab(c.id);
  assert.equal(S.req, null);
});

test('feature groups: add without duplicates, cross-project, pruned when requests go', async () => {
  const { addFeature, addToFeature, removeFromFeature, deleteFeature, featuresWith, openFeatures, feature, normalizeDB } = await import('../renderer/app/store.js');
  reset(); DB.features = [];
  const p1 = addProject('One'), p2 = addProject('Two'), f2 = addFolder(p2, 'F');
  const a = addRequest(p1, null, newReq({ name: 'a' })), b = addRequest(p2, f2, newReq({ name: 'b' }));
  const older = addFeature('Older'), feat = addFeature('Login redesign');
  assert.deepEqual(DB.features.map((f) => f.name), ['Login redesign', 'Older']); // newest first
  assert.equal(addToFeature(feat.id, a.id), true);
  assert.equal(addToFeature(feat.id, a.id), false); // no duplicates
  assert.equal(addToFeature(feat.id, b.id), true); // another project
  assert.equal(addToFeature(feat.id, 'missing'), false);
  addToFeature(older.id, a.id);
  assert.deepEqual(featuresWith(a.id).map((f) => f.name), ['Login redesign', 'Older']);
  removeFromFeature(older.id, a.id);
  assert.deepEqual(older.requestIds, []);
  feat.done = true;
  assert.deepEqual(openFeatures().map((f) => f.name), ['Older']);
  deleteRequest(a.id);
  assert.deepEqual(feat.requestIds, [b.id]);
  deleteFolder(p2, f2.id);
  assert.deepEqual(feat.requestIds, []);
  deleteFeature(older.id);
  assert.equal(feature(older.id), null);
  const db = normalizeDB({ projects: [], features: [{ id: 'x', name: 'Old data' }] });
  assert.deepEqual(db.features[0], { id: 'x', name: 'Old data', requestIds: [], notes: '', branch: '', done: false, collapsed: false });
});

test('exports leave secrets out unless asked', () => {
  const p = sampleProject();
  p.envs[0].vars.push({ k: 'apiKey', v: 'SECRET', on: true, secret: true });
  p.envs[0].network = { passphrase: 'pp' };
  const native = exportNative(p);
  assert.ok(!native.includes('SECRET') && !native.includes('"pass": "p"') && !native.includes('"passphrase": "pp"'));
  assert.ok(native.includes('"k": "apiKey"')); // the variable itself is kept, without its value
  const pm = exportPostman(p);
  assert.ok(!pm.includes('SECRET') && !pm.includes('{{tok}}'));
  assert.ok(exportNative(p, { includeSecrets: true }).includes('SECRET'));
  assert.equal(p.envs[0].vars.at(-1).v, 'SECRET'); // the project itself is untouched
});
