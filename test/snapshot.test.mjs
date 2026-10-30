// Snapshot tests: flattening, ignore rules, comparing, and judging in the runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { electronAPI: { storageSet() {} } };
const { flatten, ruleMatcher, compare, ignoreRulesFor, makeSnapshot } = await import('../renderer/app/snapshot.js');
const { judge } = await import('../renderer/app/runner.js');

const body = (o) => JSON.stringify(o);
const v1 = { id: 'a1', createdAt: '2026-10-29T10:00:00Z', items: [{ id: 1, name: 'Rex' }, { id: 2, name: 'Fido' }], meta: { traceId: 't1', page: 1 }, 'odd key': true, tags: [] };

test('flatten: leaf paths, odd keys, empty containers', () => {
  const f = flatten(v1);
  assert.equal(f.get('$.items[1].name'), 'Fido');
  assert.equal(f.get('$["odd key"]'), true);
  assert.equal(f.get('$.tags'), '[]');
  assert.equal(f.size, 10);
});

test('ignore rules: field names anywhere, wildcards, recursive, prefixes', () => {
  const m = (rule, path) => ruleMatcher(rule)(path);
  assert.equal(m('id', '$.items[3].id'), true);
  assert.equal(m('id', '$.idx'), false);
  assert.equal(m('$.items[*].id', '$.items[12].id'), true);
  assert.equal(m('$.items[*].id', '$.items[12].name'), false);
  assert.equal(m('$..traceId', '$.meta.traceId'), true);
  assert.equal(m('$.meta', '$.meta.page'), true);
  assert.equal(m('$.meta', '$.metadata'), false);
  assert.equal(m('odd key', '$["odd key"]'), true);
  assert.deepEqual(ignoreRulesFor('$.items[3].id'), { exact: '$.items[*].id', key: 'id' });
});

test('compare: status, changed / added / removed fields, ignored volatile fields, text bodies', () => {
  const snap = makeSnapshot({ status: 200, body: body(v1) }, ['createdAt', '$..traceId']);
  const same = { ...v1, id: 'a1', createdAt: '2027-01-01T00:00:00Z', meta: { traceId: 't999', page: 1 } };
  const ok = compare(snap, { status: 200, body: body(same) });
  assert.deepEqual([ok.matches, ok.ignored], [true, 2]);
  const changed = { ...same, items: [{ id: 1, name: 'Rex' }], extra: 1 };
  const r = compare(snap, { status: 201, body: body(changed) });
  assert.equal(r.matches, false);
  assert.deepEqual(r.diffs.map((d) => [d.kind, d.path]), [['status', 'status'], ['removed', '$.items[1].id'], ['removed', '$.items[1].name'], ['added', '$.extra']]);
  assert.equal(r.diffs[1].expected, '2');
  const t = compare(makeSnapshot({ status: 200, body: 'hello' }), { status: 200, body: 'hello!' });
  assert.equal(t.diffs[0].kind, 'text');
});

test('runner: a snapshot difference fails the request', () => {
  const res = { status: 200, body: '{}', snapshotResult: { matches: false, diffs: [{ path: '$.id' }] } };
  assert.deepEqual(judge({ r: { assertions: [] } }, res).failures, ['snapshot: 1 difference(s), e.g. $.id']);
});
