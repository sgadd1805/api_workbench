// Undo / redo of edits (renderer/app/edits.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { electronAPI: { storageSet() {} } };
const { DB, normalizeDB, addProject, addFolder, addRequest, addEnv, newReq, findReq, deleteRequest } = await import('../renderer/app/store.js');
const { track, undo, redo, resetEdits, markAutomatic, canUndo, canRedo } = await import('../renderer/app/edits.js');

function setup() {
  Object.assign(DB, { projects: [], features: [], notes: [], tokenSources: [], settings: {} });
  normalizeDB(DB);
  const p = addProject('Shop'); const f = addFolder(p, 'Orders');
  const a = addRequest(p, f, newReq({ name: 'List orders', url: 'http://x/orders' }));
  const b = addRequest(p, f, newReq({ name: 'Get order', url: 'http://x/orders/1' }));
  const env = addEnv(p, 'dev'); env.vars.push({ k: 'token', v: 'one', on: true });
  resetEdits();
  return { p, f, a, b, env };
}

test('an edit is undone and redone in place (open tabs keep their request object)', () => {
  const { a } = setup();
  a.url = 'http://x/orders?status=OPEN'; a.name = 'Open orders'; track();
  assert.equal(canUndo(), true);
  assert.equal(undo(), '“Open orders”');
  assert.deepEqual([a.url, a.name, findReq(a.id).r === a], ['http://x/orders', 'List orders', true]);
  assert.equal(canRedo(), true);
  assert.equal(redo(), '“Open orders”');
  assert.equal(a.url, 'http://x/orders?status=OPEN');
  assert.equal(track(), null, 'undo / redo themselves are not new steps');
});

test('a send\'s stored token is not a step, and undoing an earlier edit leaves it alone', () => {
  const { a, env } = setup();
  a.url = 'http://x/v2/orders'; track();
  env.vars[0].v = 'two'; markAutomatic(); track(); // an extract rule after a send
  undo();
  assert.equal(a.url, 'http://x/orders');
  assert.equal(env.vars[0].v, 'two', 'the token the send stored stays');
  assert.equal(canUndo(), false);
});

test('deleting a request, a folder or a project comes back, with the same ids and order', () => {
  const { p, a, b } = setup();
  deleteRequest(a.id); track();
  assert.equal(findReq(a.id), null);
  assert.match(undo(), /“List orders”/);
  assert.deepEqual(p.folders[0].requests.map((r) => r.name), ['List orders', 'Get order'], 'folders are rebuilt (the app finds them by id)');
  assert.equal(findReq(a.id).r.id, a.id);
  p.folders = []; track();
  undo();
  assert.deepEqual(p.folders[0].requests.map((r) => r.id), [a.id, b.id]);
  DB.projects = []; track();
  assert.match(undo(), /project “Shop”/);
  assert.equal(DB.projects[0].folders[0].requests[1].name, 'Get order');
});

test('new projects, notes and token sources; a new edit clears redo; steps are capped', () => {
  setup();
  addProject('Second'); track();
  DB.notes.push({ id: 'n', title: 'Hi', body: '', tags: [], projectId: null }); track();
  assert.equal(undo(), 'notes');
  assert.equal(DB.notes.length, 0);
  assert.equal(undo(), 'project “Second”');
  assert.deepEqual(DB.projects.map((p) => p.name), ['Shop']);
  redo();
  assert.deepEqual(DB.projects.map((p) => p.name), ['Shop', 'Second']);
  DB.projects[0].name = 'Shop 2'; track();
  assert.equal(canRedo(), false);
  for (let i = 0; i < 150; i++) { DB.projects[0].cookies = `n=${i}`; track(); }
  let n = 0; while (undo()) n++;
  assert.equal(n, 100);
});

test('a send that changed nothing undoable doesn\'t swallow the next edit', () => {
  const { a } = setup();
  markAutomatic(); track(); // e.g. only cookies or nothing changed
  a.name = 'Renamed'; track();
  assert.equal(undo(), '“Renamed”');
  assert.equal(a.name, 'List orders');
});

test('settings changes are not steps', () => {
  setup();
  DB.settings.theme = 'light'; assert.equal(track(), null);
});
