// OpenTelemetry receiver: OTLP/HTTP protobuf and JSON, OTLP/gRPC, normalised spans per trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const otel = require('../main/otel.js');
const grpc = require('@grpc/grpc-js');

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const ns = (ms) => String(BigInt(ms) * 1000000n);
const span = (spanId, parent, name, startMs, endMs, extra = {}) => ({
  traceId: Buffer.from(TRACE, 'hex'), spanId: Buffer.from(spanId, 'hex'), parentSpanId: parent ? Buffer.from(parent, 'hex') : undefined,
  name, kind: 2, startTimeUnixNano: ns(startMs), endTimeUnixNano: ns(endMs), ...extra,
});
const request = (spans, service = 'pets') => otel.Req.encode(otel.Req.create({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeSpans: [{ scope: { name: 'io.opentelemetry.spring' }, spans }] }] })).finish();

test('OTLP over HTTP (protobuf + JSON) and gRPC → one trace', async (t) => {
  const seen = [];
  otel.setListener((ids) => seen.push(...ids));
  const ports = await otel.start({ httpPort: 0, grpcPort: 0 });
  t.after(() => otel.stop());
  // protobuf: server span + a DB child with an error
  const body = request([
    span('b7ad6b7169203331', null, 'GET /api/pets/{id}', 1700000000000, 1700000000120, { attributes: [{ key: 'http.request.method', value: { stringValue: 'GET' } }, { key: 'http.response.status_code', value: { intValue: '500' } }] }),
    span('00f067aa0ba902b7', 'b7ad6b7169203331', 'SELECT pets', 1700000000010, 1700000000100, { kind: 3, attributes: [{ key: 'db.system', value: { stringValue: 'postgresql' } }], status: { code: 2, message: 'deadlock' } }),
  ]);
  let r = await fetch(`http://127.0.0.1:${ports.http}/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/x-protobuf' }, body });
  assert.equal(r.status, 200);
  // JSON form (hex ids, string nanos): a downstream service's span
  r = await fetch(`http://127.0.0.1:${ports.http}/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'payments' } }] }, scopeSpans: [{ spans: [{ traceId: TRACE, spanId: '1111111111111111', parentSpanId: '00f067aa0ba902b7', name: 'POST /charge', kind: 'SPAN_KIND_SERVER', startTimeUnixNano: ns(1700000000020), endTimeUnixNano: ns(1700000000060) }] }] }] }) });
  assert.equal(r.status, 200);
  // gRPC export
  const Client = grpc.makeGenericClientConstructor({ Export: { path: '/opentelemetry.proto.collector.trace.v1.TraceService/Export', requestStream: false, responseStream: false, requestSerialize: (b) => Buffer.from(b), responseDeserialize: (b) => b } }, 'TraceService');
  const client = new Client(`127.0.0.1:${ports.grpc}`, grpc.credentials.createInsecure());
  await new Promise((resolve, reject) => client.Export(request([span('2222222222222222', 'b7ad6b7169203331', 'cache get', 1700000000001, 1700000000003)], 'pets'), (err) => (err ? reject(err) : resolve())));
  client.close();
  const spans = otel.trace(TRACE.toUpperCase());
  assert.deepEqual(spans.map((s) => [s.name, s.service, s.kind, Math.round(s.ms)]), [
    ['GET /api/pets/{id}', 'pets', 'server', 120], ['cache get', 'pets', 'server', 2], ['SELECT pets', 'pets', 'client', 90], ['POST /charge', 'payments', 'server', 40]]);
  const db = spans.find((s) => s.name === 'SELECT pets');
  assert.deepEqual([db.parentId, db.status, db.attributes['db.system']], ['b7ad6b7169203331', { code: 'error', message: 'deadlock' }, 'postgresql']);
  assert.equal(spans[0].attributes['http.response.status_code'], 500);
  assert.ok(seen.includes(TRACE));
  const recent = otel.recent();
  assert.deepEqual([recent[0].id, recent[0].spans, recent[0].root, recent[0].errors], [TRACE, 4, 'GET /api/pets/{id}', 1]);
  // metrics are accepted and dropped; junk is a 400
  assert.equal((await fetch(`http://127.0.0.1:${ports.http}/v1/metrics`, { method: 'POST', body: 'x' })).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${ports.http}/v1/traces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' })).status, 400);
});
