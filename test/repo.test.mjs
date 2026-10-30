// Requests as files in the repo: what's written (no secrets), round trip, and merging back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

globalThis.window = { electronAPI: { storageSet() {} } };
const { DB, addProject, addFolder, addRequest, addEnv, newReq } = await import('../renderer/app/store.js');
const { toRepo, fromRepo } = await import('../renderer/app/repo.js');
const files = createRequire(import.meta.url)('../main/repofiles.js');

function sample() {
  DB.projects = [];
  const p = addProject('Pets');
  p.codeFolder = '/work/pets';
  const env = addEnv(p, 'dev');
  env.vars.push({ k: 'baseUrl', v: 'http://localhost:8080', on: true }, { k: 'apiKey', v: 's3cret', on: true, secret: true });
  const f = addFolder(p, 'Admin Tools');
  addRequest(p, null, newReq({ name: 'List pets', url: '{{baseUrl}}/pets', auth: { type: 'bearer', token: 'eyJliteral' } }));
  addRequest(p, f, newReq({ name: 'Create pet', method: 'POST', url: '{{baseUrl}}/pets', auth: { type: 'bearer', token: '{{token}}' }, body: { type: 'json', text: '{"name":"Rex"}', form: [] } }));
  const g = addRequest(p, f, newReq({ name: 'Get pet (gRPC)', url: 'grpc://localhost:9090' }));
  Object.assign(g, { kind: 'grpc', grpc: { protoFile: '/work/pets/proto/pets.proto', includeDirs: '', service: 'pets.v1.PetService', method: 'GetPet' } });
  return { p, f };
}

test('toRepo: one file per request, folders as directories, secrets left out, paths relative', () => {
  const { p } = sample();
  const { project, files: out } = toRepo(p);
  assert.deepEqual(out.map((x) => x.rel), ['list-pets.request.yaml', 'admin-tools/create-pet.request.yaml', 'admin-tools/get-pet-grpc.request.yaml']);
  assert.equal(out[0].data.auth.token, '');          // literal token dropped
  assert.equal(out[1].data.auth.token, '{{token}}'); // variable kept
  assert.equal(out[2].data.grpc.protoFile, 'proto/pets.proto');
  assert.deepEqual(project.environments[0].variables, [{ name: 'baseUrl', value: 'http://localhost:8080' }, { name: 'apiKey', secret: true }]);
  assert.ok(!JSON.stringify({ project, out }).includes('s3cret') && !JSON.stringify(out).includes('eyJliteral'));
});

test('write → read → merge into another machine\'s empty project; edits, deletions and local-only requests', () => {
  const { p } = sample();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  const first = files.writeCollection({ dir, ...toRepo(p) });
  assert.deepEqual([first.written, first.removed], [4, 0]); // project.yaml + 3 requests
  assert.match(fs.readFileSync(path.join(dir, 'admin-tools', 'create-pet.request.yaml'), 'utf8'), /^# API Workbench request[\s\S]*method: POST/);
  assert.equal(files.writeCollection({ dir, ...toRepo(p) }).written, 0); // nothing changed → nothing rewritten

  // A teammate loads it into an empty project.
  const ids = [...p.requests, ...p.folders.flatMap((f) => f.requests)].map((r) => r.id);
  DB.projects = [];
  const q = addProject('Pets (teammate)'); q.codeFolder = '/home/bo/pets';
  let stats = fromRepo(q, files.readCollection({ dir }));
  assert.deepEqual([stats.added, stats.updated, stats.removed], [3, 0, 0]);
  assert.deepEqual(q.folders.map((f) => f.name), ['Admin Tools']);
  assert.deepEqual([q.requests.length, q.folders[0].requests.length], [1, 2]);
  assert.deepEqual([...q.requests, ...q.folders[0].requests].map((r) => r.id), ids);
  assert.equal(q.folders[0].requests[1].grpc.protoFile, '/home/bo/pets/proto/pets.proto');
  assert.deepEqual(q.envs[0].vars.map((v) => [v.k, v.v, !!v.secret]), [['baseUrl', 'http://localhost:8080', false], ['apiKey', '', true]]);

  // Local secret survives a reload; an edit in the repo comes through; a delete in the repo removes it here;
  // a request that was never synced stays.
  q.requests[0].auth = { type: 'bearer', token: 'my-local-token' };
  q.envs[0].vars[0].v = 'http://my-machine:9000';
  const localOnly = addRequest(q, null, newReq({ name: 'scratch' }));
  const out = toRepo(p);
  out.files[1].data.url = '{{baseUrl}}/v2/pets';
  out.files.splice(2, 1); // the gRPC request was deleted in the repo
  const second = files.writeCollection({ dir, ...out });
  assert.equal(second.removed, 1);
  stats = fromRepo(q, files.readCollection({ dir }));
  assert.deepEqual([stats.added, stats.updated, stats.removed], [0, 2, 1]);
  assert.equal(q.requests[0].auth.token, 'my-local-token');
  assert.equal(q.folders[0].requests[0].url, '{{baseUrl}}/v2/pets');
  assert.equal(q.folders[0].requests.length, 1);
  assert.ok(q.requests.includes(localOnly));
  assert.equal(q.envs[0].vars[0].v, 'http://my-machine:9000'); // local values never overwritten
});

test('repo files: refuses paths outside the folder, reports unreadable files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  assert.throws(() => files.writeCollection({ dir, project: {}, files: [{ rel: '../escape.request.yaml', data: {} }] }), /outside/);
  assert.throws(() => files.writeCollection({ dir, project: {}, files: [{ rel: 'x.txt', data: {} }] }), /must end with/);
  fs.writeFileSync(path.join(dir, 'bad.request.yaml'), 'id: [unclosed');
  const res = files.readCollection({ dir });
  assert.equal(res.requests.length, 0); assert.match(res.errors[0], /^bad\.request\.yaml/);
});
