// Variable history (renderer/app/varlog.js) and where changes come from.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
globalThis.window = { electronAPI: { storageSet() {} } };
const { recordVar, varHistory, lastChange, resetVarHistory } = await import('../renderer/app/varlog.js');
const { DB, addProject, addEnv, setVar } = await import('../renderer/app/store.js');

test('changes are recorded newest first, unchanged values skipped, secrets never kept', () => {
  resetVarHistory();
  const p = { id: 'p', name: 'Shop' }, env = { id: 'e', name: 'dev' };
  recordVar({ p, env, name: 'orderId', before: undefined, value: '40123', source: '3. POST /orders: extract order.id', kind: 'extract', now: 1 });
  recordVar({ p, env, name: 'orderId', before: '40123', value: '40123', source: 'x', now: 2 });
  recordVar({ p, env, name: 'token', before: 'old-secret', value: 'new-secret', secret: true, source: 'script', kind: 'script', now: 3 });
  const h = varHistory();
  assert.deepEqual(h.map((e) => [e.name, e.before, e.value, e.at]), [['token', '••••••', '••••••', 3], ['orderId', '', '40123', 1]]);
  assert.ok(!JSON.stringify(h).includes('secret-'), 'no secret value anywhere');
  assert.equal(lastChange('e', 'orderId').source, '3. POST /orders: extract order.id');
  assert.deepEqual(varHistory({ name: 'orderId' }).length, 1);
});

test('typing in a field is one change, not one per keystroke', () => {
  resetVarHistory();
  const p = { id: 'p' }, env = { id: 'e' };
  for (const [i, v] of ['h', 'he', 'hel', 'hello'].entries()) recordVar({ p, env, name: 'greeting', before: v.slice(0, -1), value: v, kind: 'edit', now: 1000 + i * 100 });
  recordVar({ p, env, name: 'greeting', before: 'hello', value: 'hello!', kind: 'edit', now: 20000 });
  assert.deepEqual(varHistory().map((e) => e.value), ['hello!', 'hello']);
});

test('setVar records what set it; long values are cut', () => {
  resetVarHistory();
  DB.projects = [];
  const p = addProject('Shop'); const env = addEnv(p, 'dev'); p.activeEnv = env.id;
  setVar(p, 'orderId', '1', { source: 'Create order: extract id', kind: 'extract' });
  setVar(p, 'orderId', '2', { source: 'Create order: extract id', kind: 'extract' });
  setVar(p, 'blob', 'x'.repeat(1000));
  const h = varHistory({ projectId: p.id });
  assert.deepEqual(h.map((e) => [e.name, e.before, e.value.length, e.envName, e.kind]), [['blob', '', 200, 'dev', 'other'], ['orderId', '1', 1, 'dev', 'extract'], ['orderId', '', 1, 'dev', 'extract']]);
});

test('values of credential-looking variables are never kept, secret or not', () => {
  resetVarHistory();
  recordVar({ p: { id: 'p' }, env: { id: 'e' }, name: 'accessToken', before: 'a', value: 'tok_live_123', kind: 'extract' });
  recordVar({ p: { id: 'p' }, env: { id: 'e' }, name: 'csrfToken', before: 'b', value: 'csrf_9', kind: 'extract' });
  assert.deepEqual(varHistory().map((e) => [e.value, e.before, e.secret]), [['••••••', '••••••', true], ['••••••', '••••••', true]]);
  assert.ok(!globalThis.localStorage.getItem('var-history')?.includes('tok_live'));
});
