'use strict';
// A local OpenTelemetry trace receiver: apps under test export spans here (OTLP over HTTP on 4318 —
// protobuf or JSON — and over gRPC on 4317), and a response's Trace tab shows the spans of its trace
// (requests carry traceparent, so the app's spans share its trace id). Only traces are kept; metrics and
// logs requests are accepted and dropped. Spans live in memory (newest 500 traces).
const http = require('http');
const zlib = require('zlib');
const protobuf = require('protobufjs');

// The parts of opentelemetry-proto this needs (field numbers as in the spec).
const PROTO = `syntax = "proto3";
package otlp;
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ExportTraceServiceResponse { }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
message Resource { repeated KeyValue attributes = 1; }
message ScopeSpans { Scope scope = 1; repeated Span spans = 2; }
message Scope { string name = 1; string version = 2; }
message Span {
  bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; bytes parent_span_id = 4; string name = 5;
  int32 kind = 6; fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8; repeated KeyValue attributes = 9;
  repeated Event events = 11; Status status = 15;
}
message Event { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; }
message Status { string message = 2; int32 code = 3; }
message KeyValue { string key = 1; AnyValue value = 2; }
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes bytes_value = 7; } }
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }`;

const root = protobuf.parse(PROTO, { keepCase: false }).root;
const Req = root.lookupType('otlp.ExportTraceServiceRequest');
const Res = root.lookupType('otlp.ExportTraceServiceResponse');

const MAX_TRACES = 500;
const traces = new Map(); // trace id (hex) → { id, spans: [span], updated }
const KIND = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];

const hex = (v) => (v == null ? '' : typeof v === 'string' ? (/^[0-9a-f]+$/i.test(v) ? v.toLowerCase() : Buffer.from(v, 'base64').toString('hex')) : Buffer.from(v).toString('hex'));
const nanosToMs = (v) => (v == null ? 0 : Number(BigInt(typeof v === 'object' && v.low !== undefined ? protobuf.util.Long.fromValue(v).toString() : String(v))) / 1e6);

function anyValue(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(anyValue);
  if (v.kvlistValue) return attrs(v.kvlistValue.values);
  if (v.bytesValue !== undefined) return hex(v.bytesValue);
  return null;
}
const attrs = (list) => Object.fromEntries((list || []).map((kv) => [kv.key, anyValue(kv.value)]));

// An OTLP ExportTraceServiceRequest (decoded protobuf, or the JSON form) → our spans.
function normalize(req) {
  const out = [];
  for (const rs of req.resourceSpans || req.resource_spans || []) {
    const resource = attrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans || rs.scope_spans || rs.instrumentationLibrarySpans || []) {
      for (const s of ss.spans || []) {
        const start = nanosToMs(s.startTimeUnixNano ?? s.start_time_unix_nano), end = nanosToMs(s.endTimeUnixNano ?? s.end_time_unix_nano);
        out.push({
          traceId: hex(s.traceId ?? s.trace_id), spanId: hex(s.spanId ?? s.span_id), parentId: hex(s.parentSpanId ?? s.parent_span_id) || null,
          name: s.name || '', kind: KIND[s.kind] || (typeof s.kind === 'string' ? s.kind.replace(/^SPAN_KIND_/, '').toLowerCase() : 'internal'),
          start, end, ms: Math.max(0, end - start), service: resource['service.name'] || 'unknown', scope: ss.scope?.name || '',
          attributes: attrs(s.attributes), status: { code: s.status?.code === 2 || s.status?.code === 'STATUS_CODE_ERROR' ? 'error' : s.status?.code === 1 ? 'ok' : 'unset', message: s.status?.message || '' },
          events: (s.events || []).map((e) => ({ name: e.name, at: nanosToMs(e.timeUnixNano ?? e.time_unix_nano), attributes: attrs(e.attributes) })),
        });
      }
    }
  }
  return out;
}

let onSpans = () => {};
function store(spans) {
  const touched = new Set();
  for (const s of spans) {
    if (!s.traceId) continue;
    const t = traces.get(s.traceId) || { id: s.traceId, spans: [], updated: 0 };
    if (!t.spans.some((x) => x.spanId === s.spanId)) t.spans.push(s);
    t.updated = Date.now();
    traces.delete(s.traceId); traces.set(s.traceId, t); // most recently updated last
    touched.add(s.traceId);
  }
  while (traces.size > MAX_TRACES) traces.delete(traces.keys().next().value);
  if (touched.size) onSpans([...touched]);
  return touched.size;
}

// Accepts an OTLP/HTTP body. → { spans } | throws
function ingestHttp(body, contentType = '', encoding = '') {
  let buf = body;
  if (/gzip/i.test(encoding)) buf = zlib.gunzipSync(buf);
  const req = /json/i.test(contentType) ? JSON.parse(buf.toString('utf8')) : Req.toObject(Req.decode(buf), { longs: String, bytes: String, defaults: false });
  const spans = normalize(req);
  store(spans);
  return { spans: spans.length };
}

let httpServer = null, grpcServer = null, ports = {};

async function start({ httpPort = 4318, grpcPort = 4317 } = {}) {
  await stop();
  httpServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const json = /json/i.test(req.headers['content-type'] || '');
      if (req.method !== 'POST' || !/^\/v1\/(traces|metrics|logs)$/.test(req.url.split('?')[0])) { res.writeHead(404); return res.end(); }
      try {
        if (req.url.startsWith('/v1/traces')) ingestHttp(Buffer.concat(chunks), req.headers['content-type'], req.headers['content-encoding']);
        res.writeHead(200, { 'Content-Type': json ? 'application/json' : 'application/x-protobuf' });
        res.end(json ? '{}' : Buffer.from(Res.encode(Res.create({})).finish()));
      } catch (err) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad OTLP request: ' + err.message); }
    });
  });
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(httpPort, '127.0.0.1', resolve); });
  ports = { http: httpServer.address().port };
  if (grpcPort !== null) {
    try {
      const grpc = require('@grpc/grpc-js');
      grpcServer = new grpc.Server();
      const method = (path) => ({ path, requestStream: false, responseStream: false,
        requestDeserialize: (b) => Req.toObject(Req.decode(b), { longs: String, bytes: String }), requestSerialize: (o) => Buffer.from(Req.encode(o).finish()),
        responseSerialize: () => Buffer.from(Res.encode(Res.create({})).finish()), responseDeserialize: () => ({}) });
      grpcServer.addService({ Export: method('/opentelemetry.proto.collector.trace.v1.TraceService/Export') }, { Export: (call, cb) => { store(normalize(call.request)); cb(null, {}); } });
      // Metrics / logs exporters pointed here get an empty success instead of errors in the app's log.
      const drop = (path) => ({ path, requestStream: false, responseStream: false, requestDeserialize: () => ({}), requestSerialize: () => Buffer.alloc(0), responseSerialize: () => Buffer.alloc(0), responseDeserialize: () => ({}) });
      grpcServer.addService({ Export: drop('/opentelemetry.proto.collector.metrics.v1.MetricsService/Export') }, { Export: (_c, cb) => cb(null, {}) });
      grpcServer.addService({ Export: drop('/opentelemetry.proto.collector.logs.v1.LogsService/Export') }, { Export: (_c, cb) => cb(null, {}) });
      ports.grpc = await new Promise((resolve, reject) => grpcServer.bindAsync(`127.0.0.1:${grpcPort}`, grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))));
    } catch (err) { grpcServer?.forceShutdown(); grpcServer = null; ports.grpcError = err.message; }
  }
  return ports;
}

async function stop() {
  if (httpServer) { httpServer.closeAllConnections?.(); await new Promise((r) => httpServer.close(() => r())); httpServer = null; }
  if (grpcServer) { grpcServer.forceShutdown(); grpcServer = null; }
  ports = {};
}

const trace = (id) => traces.get(String(id).toLowerCase())?.spans.slice().sort((a, b) => a.start - b.start) || [];
const recent = (n = 50) => [...traces.values()].slice(-n).reverse().map((t) => {
  const root = t.spans.find((s) => !s.parentId || !t.spans.some((x) => x.spanId === s.parentId)) || t.spans[0];
  return { id: t.id, spans: t.spans.length, root: root?.name, service: root?.service, start: Math.min(...t.spans.map((s) => s.start)), errors: t.spans.filter((s) => s.status.code === 'error').length };
});

function register(ipcMain) {
  const { broadcast } = require('./windows');
  onSpans = (ids) => broadcast('otel-spans', ids);
  const guard = (fn) => async (_e, arg) => { try { return { ok: true, ...(await fn(arg || {})) }; } catch (err) { return { ok: false, error: err.code === 'EADDRINUSE' ? `Port ${err.port || ''} is already in use (another collector running?)` : err.message }; } };
  ipcMain.handle('otel-start', guard((opts) => start(opts).then((p) => ({ ports: p }))));
  ipcMain.handle('otel-stop', guard(() => stop().then(() => ({}))));
  ipcMain.handle('otel-status', () => ({ running: !!httpServer, ports, traces: traces.size }));
  ipcMain.handle('otel-trace', (_e, id) => trace(id));
  ipcMain.handle('otel-recent', () => recent());
}

module.exports = { start, stop, ingestHttp, normalize, trace, recent, Req, register, setListener: (fn) => { onSpans = fn; } };
