// The new screens render (no DOM needed): multipart / file body editors, History's "send again with one change"
// with a comparison, the runner's steps and paused step, the mock server's stateful / fault controls, and the
// Fuzz page with results.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const noop = () => {};
globalThis.window = { electronAPI: new Proxy({ storageSet: noop, historyAppend: noop }, { get: (t, k) => t[k] || (() => Promise.resolve({ ok: true })) }) };
globalThis.navigator ||= { platform: 'MacIntel' };
const { DB, S, newReq, addProject, addRequest, addFolder, activateTab, normalizeDB } = await import('../renderer/app/store.js');
const { renderTabBody } = await import('../renderer/app/views/request.js');
const { historyPageHtml } = await import('../renderer/app/views/history.js');
const { runnerPageHtml } = await import('../renderer/app/views/runner.js');
const { specToolsHtml, specCardToolsHtml } = await import('../renderer/app/views/spectools.js');
const { fuzzPageHtml } = await import('../renderer/app/views/fuzz.js');
const { cacheSpec } = await import('../renderer/app/openapi/registry.js');
const { recordReplay, historyEntries } = await import('../renderer/app/history.js');
const { compareResponses } = await import('../renderer/app/replay.js');

Object.assign(DB, { projects: [], features: [], notes: [], tokenSources: [], settings: { sidebarWidth: 240, openTabs: [], activeTab: null } }); normalizeDB(DB);
const p = addProject('Shop');
p.envs.push({ id: 'e1', name: 'dev', vars: [{ k: 'baseUrl', v: 'http://h', on: true }], loginUrls: [], network: {} }); p.activeEnv = 'e1';
const f = addFolder(p, 'Orders');
const r = addRequest(p, f, newReq({ name: 'Upload', method: 'POST', url: '{{baseUrl}}/up', body: { type: 'multipart', text: '', form: [{ k: 'title', v: 'x', on: true }, { k: 'pic', v: '/a<b>.png', on: true, file: true }] } }));
S.projectId = p.id;
activateTab(r.id);

test('Body tab: multipart rows with text / file switches, and a file body', () => {
  S.tabs[0].editorTab = 'body';
  const html = renderTabBody(r);
  assert.match(html, /value="multipart" checked/);
  assert.match(html, /data-action="part-kind" data-idx="1"[^>]*>File</);
  assert.match(html, /data-action="part-file" data-idx="1"/);
  assert.match(html, /\/a&lt;b&gt;\.png/, 'paths are escaped');
  r.body.type = 'binary'; r.body.file = '/x.bin';
  assert.match(renderTabBody(r), /id="body-file"[^>]*value="\/x\.bin"/);
  r.body.type = 'multipart';
});

test('History entry: the re-send form, and the comparison after a re-send', () => {
  const base = { id: 'h0', at: Date.now(), reqId: r.id, reqName: r.name, projectId: p.id, method: 'POST', url: 'http://h/up?x=1',
    request: { headers: { 'Content-Type': 'application/json' }, body: '{"qty":1}' }, response: { status: 201, headers: {}, body: '{"ok":true,"n":1}', time: 10 } };
  historyEntries().unshift(base);
  S.history.id = 'h0';
  for (const kind of ['header', 'query', 'body', 'env', 'none']) {
    S.history.replay.kind = kind;
    const html = historyPageHtml();
    assert.match(html, /Send again with one change/);
    if (kind === 'body') assert.match(html, /<option value="qty">/);
    if (kind === 'env') assert.match(html, /<option value="e1" selected>dev \(active\)/);
  }
  const res = { status: 400, headers: { 'content-type': 'application/json' }, body: '{"ok":false,"n":1}', time: 3, requestData: { method: 'POST', url: base.url, headers: {}, body: '{"qty":-1}' } };
  const entry = recordReplay(base, res, { change: 'body qty = -1' });
  S.history.replay.result = { baseId: 'h0', entryId: entry.id, res, change: 'body qty = -1', notes: ['History had blanked Authorization'], cmp: compareResponses(base.response, res) };
  const html = historyPageHtml();
  assert.match(html, /body qty = -1/);
  assert.match(html, /open the new entry/);
  assert.match(html, /<td>Status<\/td><td>201<\/td><td class="diff-add">400<\/td>/);
  assert.match(html, /<code>\$\.ok<\/code>/);
  assert.match(html, /History had blanked Authorization/);
  S.history.id = entry.id; S.history.replay.result = null;
  assert.match(historyPageHtml(), /re-sent body qty = -1 from/);
});

test('Runner: steps with breakpoints, and a paused step', () => {
  S.runner.scopeKey = `folder|${f.id}`;
  S.runner.breakpoints.add(r.id);
  let html = runnerPageHtml();
  assert.match(html, /class="bp-dot on" data-action="run-bp" data-id="[^"]+"/);
  assert.match(html, /1 breakpoint/);
  Object.assign(S.runner, { running: true, at: { reqId: r.id, index: 0 },
    paused: { loc: { p, f, r }, vars: {}, pos: { index: 0, iteration: 1 }, current: { baseUrl: 'http://h' }, save: false,
      draft: { method: 'POST', url: r.url, headers: [], text: '', bodyType: 'multipart' }, varRows: [{ k: 'baseUrl', v: 'http://h', on: true }] } });
  html = runnerPageHtml();
  assert.match(html, /⏸ Paused before 1\. Upload/);
  assert.match(html, /data-action="run-continue"/);
  assert.match(html, /data-list="rp-vars"/);
  assert.match(html, /The multipart body is sent as saved/);
  Object.assign(S.runner, { running: false, paused: null, at: null, results: [{ iteration: 1, reqId: r.id, name: 'Upload', method: 'POST', status: null, time: 0, skipped: true, passed: true, failures: [] }] });
  assert.match(runnerPageHtml(), /1 skipped/);
  S.runner.breakpoints.clear(); S.runner.results = [];
});

test('Mock panel: stateful mode and faults', () => {
  const meta = { id: 'spec1', title: 'Shop API', source: { type: 'file', location: '/x.yaml' } };
  p.specs.push(meta);
  cacheSpec('spec1', { openapi: '3.0.0', paths: { '/pets': { get: { responses: { 200: {} } } } } });
  S.specTools.mockOpen = 'spec1';
  S.specTools.mock.spec1 = { running: true, port: 1, url: 'http://127.0.0.1:1', delayMs: 0, override: '', overrides: {}, hits: [{ at: 1, method: 'GET', url: '/pets', status: 503, route: 'GET /pets', ms: 2, note: 'fault: random' }],
    stateful: true, faults: { errorRate: 10, errorStatus: 'hang', failFirst: 2, jitterMs: 0, slowRate: 0, slowMs: 3000 }, store: [{ path: '/pets', count: 3 }] };
  const html = specToolsHtml(p);
  assert.match(html, /id="mock-stateful" checked/);
  assert.match(html, /Stored: \/pets \(3\)/);
  assert.match(html, /<option value="hang" selected>/);
  assert.match(html, /id="mock-fail-first" value="2"/);
  assert.match(html, /class="warn-text">fault: random/);
  assert.match(specCardToolsHtml(meta), new RegExp(`data-action="open-fuzz" data-scope="project\\|${p.id}"`));
  assert.match(specCardToolsHtml(meta), /● Mock on :1/);
});

test('Fuzz page: options, and results grouped by request', () => {
  S.fuzz.scopeKey = `request|${r.id}`;
  let html = fuzzPageHtml();
  assert.match(html, /Request: Upload/);
  assert.match(html, /Use a test environment/);
  S.fuzz.results = [{ reqId: r.id, name: 'Upload', method: 'POST', op: 'POST /up', spec: 'Shop API', baseline: { status: 201, time: 5 }, cases: [
    { id: 'x1', label: 'wrong type (text)', where: 'body.qty', group: 'body', expect: 'reject', verdict: 'server-error', issues: [], status: 500, time: 3, wire: { method: 'POST', url: 'http://h/up', headers: {}, body: '{"qty":"x"}' }, response: { status: 500, headers: {}, body: 'boom' } },
    { id: 'x2', label: 'null', where: 'body.qty', group: 'body', expect: 'reject', verdict: 'ok', issues: [], status: 400, time: 2, wire: { method: 'POST', url: 'http://h/up', headers: {}, body: '{}' }, response: null },
  ] }];
  S.fuzz.open[r.id] = true; S.fuzz.selected = 'x1';
  html = fuzzPageHtml();
  assert.match(html, /2 cases/);
  assert.match(html, /1 server errors/);
  assert.match(html, /Server error/);
  assert.match(html, /data-action="fuzz-save" data-id="x1"/);
  assert.ok(!/>null</.test(html), 'only problems by default');
  S.fuzz.onlyProblems = false;
  assert.match(fuzzPageHtml(), />null</);
});
