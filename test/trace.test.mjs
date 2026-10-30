// Trace tab: tree order, labels, and the waterfall markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { electronAPI: { storageSet() {} } };
const { treeOrder, spanLabel, traceHtml } = await import('../renderer/app/views/trace.js');

const sp = (spanId, parentId, name, start, end, extra = {}) => ({ spanId, parentId, name, start, end, ms: end - start, service: 'pets', kind: 'internal', attributes: {}, status: { code: 'unset', message: '' }, events: [], ...extra });
const spans = [
  sp('c', 'a', 'SELECT', 30, 90, { kind: 'client', attributes: { 'db.system': 'postgresql', 'db.statement': 'select * from pets where id=?' }, status: { code: 'error', message: 'deadlock' } }),
  sp('a', null, 'GET /api/pets/{id}', 0, 100, { kind: 'server' }),
  sp('b', 'a', 'cache', 5, 10),
  sp('d', 'zz', 'orphan', 95, 99, { kind: 'client', service: 'payments', attributes: { 'http.request.method': 'POST', 'url.full': 'http://pay/charge' } }),
];

test('tree order: parents first, children by start, orphans as roots', () => {
  assert.deepEqual(treeOrder(spans).map(({ span, depth }) => `${span.spanId}${depth}`), ['a0', 'b1', 'c1', 'd0']);
});

test('labels: DB statements, outgoing HTTP calls', () => {
  assert.deepEqual(spanLabel(spans[0]), { tag: 'DB', text: 'postgresql: select * from pets where id=?' });
  assert.deepEqual(spanLabel(spans[3]), { tag: 'HTTP', text: 'POST http://pay/charge' });
  assert.equal(spanLabel(spans[2]), null);
});

test('waterfall: services, error and slow marks, bar geometry; empty state', () => {
  const html = traceHtml({ correlation: { traceId: 't' } }, spans, {});
  assert.match(html, /4 spans · .*pets.*payments.* · 100 ms/s);
  assert.match(html, /✗ 1 error span/);
  assert.match(html, /trace-row err slow[^"]*" data-action="otel-select" data-id="c"/); // 60 % of the trace: slow, and an error
  assert.match(html, /left:30%;width:60%/);
  const empty = traceHtml({ correlation: { traceId: 'abc' } }, [], { receiver: { running: false } });
  assert.match(empty, /No spans received yet for trace <code>abc<\/code>/);
  assert.match(empty, /data-action="otel-start"/);
});
