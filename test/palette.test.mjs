// The ⌘K palette's settings and pages (renderer/app/actions/palette.js) and the ">" mode (actions/search.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
globalThis.window = { electronAPI: new Proxy({}, { get: (_t, name) => (...args) => { calls.push(name); return Promise.resolve({ ok: true, ports: { http: 4318 } }); } }) };
// A stand-in for any element: settings re-render the app, which needs somewhere to put the HTML.
const fakeEl = () => new Proxy({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
  { get: (t, k) => (k in t ? t[k] : k === 'querySelectorAll' ? () => [] : typeof k === 'string' && /^(querySelector|closest)$/.test(k) ? () => null : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
globalThis.document = { getElementById: fakeEl, body: fakeEl(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], documentElement: fakeEl(), activeElement: null };

const { DB, S, normalizeDB, addProject, addEnv, AI_PROMPT_DEFAULTS } = await import('../renderer/app/store.js');
const { settingItems } = await import('../renderer/app/actions/palette.js');
const { paletteResults } = await import('../renderer/app/actions/search.js');
const { searchApi } = await import('../renderer/app/search.js');

function setup() {
  Object.assign(DB, { projects: [], features: [], notes: [], tokenSources: [], settings: { theme: 'dark', zoom: 1 } });
  normalizeDB(DB);
  const p = addProject('Pets'); addEnv(p, 'local'); p.activeEnv = p.envs[0].id;
  S.projectId = p.id; S.req = null; S.otel = { running: false, ports: {} };
  return p;
}
const quiet = { render() {} };
const find = (items, title) => items.find((i) => i.title === title) || assert.fail(`no item "${title}"`);

test('every option on the Settings page has a palette entry', () => {
  setup();
  const titles = settingItems({}, quiet).map((i) => i.title);
  for (const t of ['Theme: System', 'Theme: Dark', 'Theme: Light', 'Zoom in', 'Zoom out', 'Reset zoom', 'Request and response side by side', 'Request above response (stacked)',
    'Side panel', 'Session toolbar', 'Wrap long lines in editors', 'AI assistance (Ask Claude, Investigate)', 'Edit extra instructions for Claude…']) assert.ok(titles.includes(t), t);
  const aiToggles = titles.filter((t) => t.startsWith('Send to Claude: '));
  assert.equal(aiToggles.length, Object.keys(AI_PROMPT_DEFAULTS).filter((k) => k !== 'instructions').length);
});

test('toggles flip their setting, show the new state, and keep the palette open', async () => {
  setup();
  let items = settingItems({}, quiet);
  const wrap = find(items, 'Wrap long lines in editors');
  assert.deepEqual([wrap.state, wrap.keepOpen, wrap.kind], ['off', true, 'setting']);
  await wrap.run();
  assert.equal(DB.settings.editorWrap, true);
  items = settingItems({}, quiet);
  assert.equal(find(items, 'Wrap long lines in editors').state, 'on');
  assert.equal(find(items, 'Theme: Dark').state, 'current');
  await find(items, 'Theme: Light').run();
  assert.equal(DB.settings.theme, 'light');
  await find(settingItems({}, quiet), 'Zoom in').run(); await find(settingItems({}, quiet), 'Zoom in').run();
  assert.equal(DB.settings.zoom, 1.2);
  assert.equal(find(settingItems({}, quiet), 'Zoom in').state, '120%');
  for (let i = 0; i < 10; i++) await find(settingItems({}, quiet), 'Zoom in').run();
  assert.equal(DB.settings.zoom, 1.6, 'zoom stays within the Settings range');
  await find(settingItems({}, quiet), 'Send to Claude: Commit author names').run();
  assert.equal(DB.settings.aiPrompt.commitAuthors, false);
  assert.ok(calls.includes('aiEnable'), 'the main process hears about AI prompt changes');
});

test('project, environment and request settings follow the selection', async () => {
  const p = setup();
  let titles = settingItems({}, quiet).map((i) => i.title);
  assert.ok(titles.includes('Pets: correlation headers (X-Request-Id, traceparent)'));
  assert.ok(titles.includes('local: skip TLS certificate verification'));
  assert.ok(!titles.some((t) => t.endsWith(': follow redirects')), 'no request open');
  await find(settingItems({}, quiet), 'local: HTTP/2').run();
  assert.equal(p.envs[0].network.http2, true);
  await find(settingItems({}, quiet), 'Pets: flag ERROR / FATAL log lines').run();
  assert.equal(p.logWatch.levels, false);
  S.projectId = null;
  titles = settingItems({}, quiet).map((i) => i.title);
  assert.ok(!titles.some((t) => t.startsWith('Pets:')));
});

test('pages run their action', () => {
  setup();
  const ran = [];
  const actions = new Proxy({}, { get: (_t, name) => (d) => ran.push([name, d]) });
  const items = settingItems(actions, quiet);
  find(items, 'Environments').run();
  find(items, 'Sidebar: History').run();
  find(items, 'Pets: project settings…').run();
  assert.deepEqual(ran, [['open-envs', {}], ['sidebar-mode', { mode: 'history' }], ['project-settings', { id: DB.projects[0].id }]]);
  assert.ok(items.filter((i) => i.group === 'Tools').length >= 10);
});

test('">" searches only actions, settings and pages; ">" alone lists them all', () => {
  setup();
  const request = { kind: 'request', title: 'Dark mode toggle endpoint', path: '/theme', method: 'GET' };
  const list = [request, ...settingItems({}, quiet)];
  assert.ok(searchApi(list, 'dark').some((i) => i.kind === 'request'), 'without ">", requests match too');
  assert.deepEqual(paletteResults(list, '>dark').map((i) => i.title), ['Theme: Dark']);
  assert.equal(paletteResults(list, '>').length, list.length - 1);
  assert.ok(paletteResults(list, '> proxy https').some((i) => i.title === 'Proxy: decrypt HTTPS'));
  assert.ok(paletteResults(list, 'wrap').some((i) => i.title === 'Wrap long lines in editors'), 'settings also show up without ">"');
});
