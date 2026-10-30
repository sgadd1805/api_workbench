// WebSocket, Server-Sent Events and gRPC from main/protocols.js, against local servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const proto = require('../main/protocols.js');
const { WebSocketServer } = require('ws');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const events = [];
proto.setEmitter((channel, e) => events.push({ channel, ...e }));
const waitFor = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timed out'); };

test('SSE parser: multi-line data, event names, ids, comments, CRLF, split chunks', () => {
  const got = [];
  const feed = proto.sseParser((e) => got.push(e));
  feed(': keep-alive\n\ndata: one\ndata: two\n\nevent: tick\nid: 7\nretry: 500\ndata: {"n"');
  feed(':1}\r\n\r\ndata:no-space\n\n');
  assert.deepEqual(got, [
    { event: 'message', data: 'one\ntwo', lastEventId: undefined, retry: undefined },
    { event: 'tick', data: '{"n":1}', lastEventId: '7', retry: 500 },
    { event: 'message', data: 'no-space', lastEventId: '7', retry: undefined },
  ]);
});

test('WebSocket: headers on the handshake, echo, binary, close', async (t) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  let seenAuth;
  wss.on('connection', (ws, req) => {
    seenAuth = req.headers.authorization;
    ws.on('message', (m, binary) => ws.send(binary ? m : 'echo: ' + m, { binary }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { wss.close(); server.close(); });
  proto.wsConnect({ id: 'w1', url: `ws://127.0.0.1:${server.address().port}/socket`, headers: { Authorization: 'Bearer abc' } });
  await waitFor(() => events.find((e) => e.id === 'w1' && e.type === 'open'));
  assert.equal(seenAuth, 'Bearer abc');
  assert.equal(events.find((e) => e.id === 'w1' && e.type === 'handshake').status, 101);
  proto.wsSend({ id: 'w1', data: 'hi' });
  await waitFor(() => events.find((e) => e.id === 'w1' && e.type === 'message' && e.data === 'echo: hi'));
  proto.wsSend({ id: 'w1', data: Buffer.from([1, 2, 3]).toString('base64'), binary: true });
  const bin = await waitFor(() => events.find((e) => e.id === 'w1' && e.binary));
  assert.equal(bin.data, 'AQID');
  proto.wsClose({ id: 'w1', code: 1000, reason: 'bye' });
  const closed = await waitFor(() => events.find((e) => e.id === 'w1' && e.type === 'close'));
  assert.equal(closed.code, 1000);
  assert.throws(() => proto.wsSend({ id: 'w1', data: 'x' }), /Not connected/);
  // A server that refuses the upgrade.
  const plain = http.createServer((q, s) => { s.writeHead(403); s.end('nope'); });
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  t.after(() => plain.close());
  proto.wsConnect({ id: 'w2', url: `ws://127.0.0.1:${plain.address().port}/` });
  const err = await waitFor(() => events.find((e) => e.id === 'w2' && e.type === 'error'));
  assert.match(err.message, /HTTP 403/);
});

test('SSE: streams events, reports non-stream responses, stops', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/bad') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: hello ${req.headers['x-who']}\n\n`);
    let n = 0; const iv = setInterval(() => res.write(`event: tick\ndata: ${++n}\n\n`), 20);
    req.on('close', () => clearInterval(iv));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  proto.sseStart({ id: 's1', url: base + '/events', headers: { 'X-Who': 'ann' } });
  await waitFor(() => events.filter((e) => e.id === 's1' && e.event === 'tick').length >= 3);
  assert.equal(events.find((e) => e.id === 's1' && e.type === 'message').data, 'hello ann');
  assert.equal(events.find((e) => e.id === 's1' && e.type === 'open').status, 200);
  assert.deepEqual(proto.sseStop({ id: 's1' }), { stopped: true });
  assert.ok(events.some((e) => e.id === 's1' && e.type === 'close' && e.stopped));
  proto.sseStart({ id: 's2', url: base + '/bad' });
  const err = await waitFor(() => events.find((e) => e.id === 's2' && e.type === 'error'));
  assert.match(err.message, /not an event stream/);
});

test('gRPC: describe a .proto, unary call with metadata, errors mapped to HTTP status, server streaming', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grpc-'));
  const file = path.join(dir, 'pets.proto');
  fs.writeFileSync(file, `syntax = "proto3";
package pets.v1;
enum Kind { KIND_UNSPECIFIED = 0; DOG = 1; }
message GetPetRequest { string id = 1; repeated string fields = 2; }
message Pet { string id = 1; string name = 2; Kind kind = 3; Owner owner = 4; int64 born = 5; map<string, string> labels = 6; }
message Owner { string name = 1; }
message ListPetsRequest { int32 count = 1; }
service PetService {
  rpc GetPet (GetPetRequest) returns (Pet);
  rpc ListPets (ListPetsRequest) returns (stream Pet);
}`);
  const d = proto.grpcDescribe({ protoFile: file });
  const svc = d.services.find((s) => s.name === 'pets.v1.PetService');
  assert.deepEqual(svc.methods.map((m) => [m.name, m.responseStream]), [['GetPet', false], ['ListPets', true]]);
  assert.deepEqual(JSON.parse(svc.methods[0].template), { id: '', fields: [''] });

  const def = grpc.loadPackageDefinition(protoLoader.loadSync(file, { keepCase: true, longs: String, enums: String, defaults: true }));
  const server = new grpc.Server();
  server.addService(def.pets.v1.PetService.service, {
    GetPet(call, cb) {
      if (call.request.id === 'missing') return cb({ code: grpc.status.NOT_FOUND, details: 'no such pet' });
      const meta = new grpc.Metadata(); meta.add('x-served-by', 'test'); call.sendMetadata(meta);
      cb(null, { id: call.request.id, name: 'Rex', kind: 'DOG', owner: { name: call.metadata.get('x-user')[0] || '' }, born: '20200101' });
    },
    ListPets(call) { for (let i = 0; i < call.request.count; i++) call.write({ id: String(i), name: 'p' + i }); call.end(); },
  });
  const port = await new Promise((r, j) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? j(e) : r(p))));
  t.after(() => server.forceShutdown());
  const base = { url: `grpc://127.0.0.1:${port}`, grpc: { protoFile: file, service: 'pets.v1.PetService', method: 'GetPet' } };

  let res = await proto.grpcCall({ ...base, id: 'g1', headers: { 'X-User': 'ann', 'Content-Type': 'x' }, body: '{"id": "42"}' });
  assert.equal(res.status, 200); assert.equal(res.grpcCode, 0);
  const pet = JSON.parse(res.body);
  assert.deepEqual([pet.id, pet.name, pet.kind, pet.owner.name, pet.born], ['42', 'Rex', 'DOG', 'ann', '20200101']);
  assert.equal(res.headers['x-served-by'], 'test');
  assert.equal(res.headers['content-type'], 'application/json');

  res = await proto.grpcCall({ ...base, id: 'g2', body: '{"id": "missing"}' });
  assert.equal(res.status, 404); assert.equal(res.grpcCode, 5);
  assert.match(res.statusText, /NOT_FOUND \(gRPC 5\): no such pet/);

  res = await proto.grpcCall({ ...base, id: 'g3', grpc: { ...base.grpc, method: 'ListPets' }, body: '{"count": 3}' });
  assert.deepEqual(JSON.parse(res.body).map((p) => p.name), ['p0', 'p1', 'p2']);

  res = await proto.grpcCall({ ...base, id: 'g4', url: 'grpc://127.0.0.1:1', body: '{}', timeoutMs: 2000 });
  assert.equal(res.status, 503); // UNAVAILABLE
  await assert.rejects(async () => proto.grpcCall({ ...base, id: 'g5', body: '{nope' }), /must be JSON/);
  await assert.rejects(async () => proto.grpcCall({ ...base, id: 'g6', grpc: { ...base.grpc, method: 'Nope' } }), /isn't in/);
});
