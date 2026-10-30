// Spec tools: breaking-change diff, mock server, git file versions, drift check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

globalThis.window = { electronAPI: { storageSet() {} } };
const require = createRequire(import.meta.url);
const { diffSpecs, summarizeDiff } = await import('../renderer/app/openapi/diff.js');
const { mockRoutes, mockBasePath } = await import('../renderer/app/openapi/mock.js');
const { analyzeSpec } = await import('../renderer/app/openapi/spec.js');
const { cacheSpec } = await import('../renderer/app/openapi/registry.js');
const { driftCheck } = await import('../renderer/app/openapi/drift.js');
const { DB, addProject, addRequest, addEnv, newReq } = await import('../renderer/app/store.js');
const mock = require('../main/mock.js');
const git = require('../main/git.js');

const pet = (extra = {}) => ({ type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' }, name: { type: 'string' }, tag: { type: 'string' }, ...extra } });
const v1 = {
  openapi: '3.0.3', info: { title: 'Pets', version: '1' }, servers: [{ url: 'http://localhost/api/v1' }],
  paths: {
    '/pets': {
      get: { parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } } } },
      post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } } }, responses: { 201: { description: 'made', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' }, example: { id: 1, name: 'Rex' } } } } } },
    },
    '/pets/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, 404: { description: 'nope', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string', example: 'not found' } } } } } } } } },
    '/old': { get: { responses: { 200: { description: 'ok' } } } },
  },
  components: { schemas: { Pet: pet({ secret: { type: 'string', writeOnly: true } }), NewPet: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['cat', 'dog', 'bird'] } } } } },
};

test('diffSpecs: breaking vs compatible changes', () => {
  const v2 = structuredClone(v1);
  delete v2.paths['/old'];
  v2.paths['/pets'].get.parameters.push({ name: 'owner', in: 'query', required: true, schema: { type: 'string' } });
  v2.paths['/pets'].get.parameters[0].schema = { type: 'string' };              // limit: integer → string
  v2.components.schemas.Pet.properties.id = { type: 'string' };                // response type change
  delete v2.components.schemas.Pet.properties.tag;                             // response field removed
  v2.components.schemas.Pet.properties.age = { type: 'integer' };              // new response field
  v2.components.schemas.NewPet.required.push('kind');                          // request field now required
  v2.components.schemas.NewPet.properties.kind.enum = ['cat', 'dog'];          // request enum narrowed
  v2.paths['/pets/{id}'].get.responses = { 200: v2.paths['/pets/{id}'].get.responses[200] }; // 404 removed
  v2.paths['/new'] = { get: { responses: { 200: { description: 'ok' } } } };
  const changes = diffSpecs(v1, v2);
  const has = (level, op, where, re) => assert.ok(changes.some((c) => c.level === level && c.op === op && c.where === where && re.test(c.message)), `${level} ${op} ${where} ${re}\n${JSON.stringify(changes, null, 1)}`);
  has('breaking', 'GET /old', '', /Operation removed/);
  has('info', 'GET /new', '', /Operation added/);
  has('breaking', 'GET /pets', 'query.owner', /New required parameter/);
  has('breaking', 'GET /pets', 'query.limit', /Type changed: integer → string/);
  has('breaking', 'GET /pets', '200 body[].id', /Type changed/);
  has('breaking', 'GET /pets', '200 body[].tag', /Field removed/);
  has('info', 'GET /pets', '200 body[].age', /New field/);
  has('breaking', 'POST /pets', 'body.kind', /now required/);
  has('breaking', 'POST /pets', 'body.kind', /Enum values removed: "bird"/);
  has('warning', 'GET /pets/{id}', '404', /404 response removed/);
  assert.equal(changes[0].level, 'breaking'); // sorted most severe first
  assert.deepEqual(diffSpecs(v1, structuredClone(v1)), []);
  assert.ok(summarizeDiff(changes).breaking >= 7);
});

test('mock server: examples, path templates, base path, overrides, drop, CORS', async (t) => {
  const analysis = analyzeSpec(v1);
  const routes = mockRoutes(analysis, { 'GET /pets/{id}': '404' });
  assert.equal(mockBasePath(analysis), '/api/v1');
  const post = routes.find((r) => r.method === 'POST');
  assert.deepEqual(JSON.parse(post.responses[201].body), { id: 1, name: 'Rex' });
  const list = JSON.parse(routes.find((r) => r.path === '/pets' && r.method === 'GET').responses[200].body);
  assert.deepEqual(list, [{ id: 0, name: 'string', tag: 'string' }]); // writeOnly "secret" left out of responses
  const hits = [];
  const { port, url } = await mock.start({ id: 'm1', routes, basePath: mockBasePath(analysis) }, (h) => hits.push(h));
  t.after(() => mock.stop('m1'));
  assert.equal(url, `http://127.0.0.1:${port}/api/v1`);
  let r = await fetch(url + '/pets');
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-mock'), 'api-workbench');
  r = await fetch(url + '/pets/5');
  assert.equal(r.status, 404); assert.deepEqual(await r.json(), { error: 'not found' });
  r = await fetch(url + '/pets?__status=503');
  assert.equal(r.status, 503); assert.equal((await r.json()).title, 'Service Unavailable');
  r = await fetch(url + '/pets', { method: 'POST', headers: { 'X-Mock-Status': '201' }, body: '{}' });
  assert.equal(r.status, 201);
  r = await fetch(url + '/nothing');
  assert.equal(r.status, 404); assert.match((await r.json()).error, /No operation/);
  r = await fetch(url + '/pets', { method: 'OPTIONS', headers: { Origin: 'http://app.test', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), 'http://app.test');
  mock.update({ id: 'm1', override: 'drop' });
  await assert.rejects(fetch(url + '/pets'));
  mock.update({ id: 'm1', override: '', delayMs: 120 });
  const t0 = Date.now(); await (await fetch(url + '/pets')).text();
  assert.ok(Date.now() - t0 >= 100);
  assert.ok(hits.some((h) => h.status === 'dropped') && hits.some((h) => h.route === 'GET /pets/{id}' && h.status === 404));
  assert.equal(mock.match(routes, 'GET', '/pets/7').path, '/pets/{id}');
});

test('git: versions of a file and its text at a commit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('init', '-q');
  fs.mkdirSync(path.join(dir, 'api'));
  const file = path.join(dir, 'api', 'openapi.json');
  fs.writeFileSync(file, JSON.stringify(v1)); g('add', '.'); g('commit', '-qm', 'first');
  fs.writeFileSync(file, JSON.stringify({ ...v1, info: { title: 'Pets', version: '2' } })); g('commit', '-qam', 'second');
  const real = fs.realpathSync(file);
  const { commits, rel } = await git.fileVersions({ file: real });
  assert.equal(rel, 'api/openapi.json');
  assert.deepEqual(commits.map((c) => c.subject), ['second', 'first']);
  const { text } = await git.fileAt({ file: real, hash: commits[1].hash, rel: commits[1].path });
  assert.equal(JSON.parse(text).info.version, '1');
  await assert.rejects(git.fileAt({ file: real, hash: 'nothex!', rel }), /Bad commit/);
});

test('driftCheck: request issues, unmatched requests, uncovered operations', () => {
  DB.projects = [];
  const p = addProject('P'); p.correlation = false;
  const env = addEnv(p, 'dev'); env.vars.push({ k: 'baseUrl', v: 'http://localhost/api/v1', on: true });
  p.specs = [{ id: 'S1', title: 'Pets', source: { type: 'file', location: '/x' } }];
  cacheSpec('S1', v1);
  addRequest(p, null, newReq({ name: 'list', url: '{{baseUrl}}/pets?limit=abc' }));
  addRequest(p, null, newReq({ name: 'one', url: '{{baseUrl}}/pets/3' }));
  addRequest(p, null, newReq({ name: 'other', url: '{{baseUrl}}/elsewhere' }));
  const d = driftCheck(p);
  assert.deepEqual(d.counts, { requests: 3, failing: 1, unmatched: 1, uncovered: 2 });
  assert.equal(d.rows[0].loc.r.name, 'list');
  assert.match(d.rows[0].request.find((i) => i.level === 'error').where, /limit/);
  assert.deepEqual(d.uncovered.map((u) => u.op.key).sort(), ['GET /old', 'POST /pets']);
});
