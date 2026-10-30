// api-client.json: the example validates against the schema, applies into an empty app, and re-applying merges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import schema from '../docs/api-client.schema.json' with { type: 'json' };
import example from '../docs/examples/api-client.json' with { type: 'json' };

globalThis.window = { electronAPI: { storageSet() {} } };
const { DB } = await import('../renderer/app/store.js');
const { applyConfig, summaryText, linkOperations, exportConfig, configRequestPaths, requestsOnly } = await import('../renderer/app/config.js');
const { normalizeDB, AI_PROMPT_DEFAULTS } = await import('../renderer/app/store.js');
const fresh = () => { Object.assign(DB, { projects: [], features: [], notes: [], tokenSources: [], settings: { sidebarWidth: 240, openTabs: [], activeTab: null } }); normalizeDB(DB); };
const { validateSchema } = await import('../renderer/app/openapi/schema.js');

test('the example validates; typos and bad values are reported', () => {
  assert.deepEqual(validateSchema(schema, example, { root: schema }), []);
  const bad = structuredClone(example);
  bad.folders[1].requests[0].assertion = ['status === 200'];
  bad.folders[0].requests[0].method = 'FETCH';
  bad.environments[0].variables.list = [1, 2];
  const paths = validateSchema(schema, bad, { root: schema }).map((e) => e.path).sort();
  assert.deepEqual(paths, ['environments[0].variables.list', 'folders[0].requests[0].method', 'folders[1].requests[0].assertion']);
});

test('apply into an empty app: project, environments, folders, requests, features, tasks, specs', () => {
  fresh();
  const res = applyConfig(example, { codeFolder: '/work/pets' });
  const p = res.project;
  assert.equal(res.created, true);
  assert.equal(p.name, 'Pet Store'); assert.equal(p.codeFolder, '/work/pets');
  assert.deepEqual(p.auth, { type: 'bearer', token: '{{token}}' });
  assert.deepEqual(p.envs.map((e) => e.name), ['local', 'staging']);
  assert.equal(p.activeEnv, p.envs[0].id);
  assert.deepEqual(p.envs[0].vars.map((v) => [v.k, v.v, !!v.secret]), [['baseUrl', 'http://localhost:8080/api/v1', false], ['petId', '1', false], ['token', '', true]]);
  assert.deepEqual(p.folders.map((f) => [f.name, f.requests.length, f.auth.type]), [['Auth', 1, 'none'], ['Pets', 3, 'inherit'], ['Admin', 1, 'token'], ['Other protocols', 4, 'inherit']]);
  const [list, , create] = p.folders[1].requests;
  assert.equal(list.url, '{{baseUrl}}/pets?limit=20');
  assert.deepEqual(create.body, { type: 'json', text: '{\n  "name": "Rex",\n  "tag": "dog"\n}', form: [] });
  assert.deepEqual(create.chain, [{ k: 'id', v: 'petId', on: true }]);
  assert.match(create.scripts.post, /has an id/);
  assert.equal(DB.features[0].requestIds.length, 3);
  assert.equal(p.tasks[0].command, './mvnw spring-boot:run'); assert.deepEqual(p.tasks[0].env, [{ k: 'SERVER_PORT', v: '8080', on: true }]);
  assert.equal(p.logSources[0].path, '/work/pets/logs/application.log');
  assert.deepEqual(res.specs, ['/work/pets/src/main/resources/openapi.yaml']);
  assert.deepEqual(res.warnings, []);
  assert.match(summaryText(res.summary), /1 project, 1 token sources, 2 environments, .*9 requests/);
});

test('re-apply merges: matched by name, file wins, local secrets and extra items kept, nothing duplicated', () => {
  fresh();
  const p = applyConfig(example, { codeFolder: '/work/pets' }).project;
  p.envs[0].vars.find((v) => v.k === 'token').v = 'my-secret';
  p.folders[1].requests.push({ ...p.folders[1].requests[0], id: 'local1', name: 'My scratch request' });
  const next = structuredClone(example);
  next.environments[0].variables.baseUrl = 'http://localhost:9090/api/v1';
  next.folders[1].requests[0].query = { limit: 5 };
  next.features[0].requests.push('Missing request');
  const res = applyConfig(next, { project: p });
  assert.equal(res.created, false);
  assert.equal(DB.projects.length, 1);
  assert.equal(p.envs[0].vars.find((v) => v.k === 'baseUrl').v, 'http://localhost:9090/api/v1');
  assert.equal(p.envs[0].vars.find((v) => v.k === 'token').v, 'my-secret');
  assert.equal(p.folders[1].requests[0].url, '{{baseUrl}}/pets?limit=5');
  assert.equal(p.folders[1].requests.length, 4);
  assert.equal(DB.features.length, 1); assert.equal(DB.features[0].requestIds.length, 3);
  assert.deepEqual(res.warnings, ['Feature "PET-123 adoption flow": no request "Missing request"']);
  assert.deepEqual(res.summary, { 'requests updated': 9, 'app settings': 1 });
  assert.equal(DB.tokenSources.length, 1); assert.equal(DB.notes.length, 1); assert.equal(p.logSources.length, 4);
  assert.throws(() => applyConfig('nope'), /JSON object/);
});

test('apply covers every feature: token sources, log watch, actuator, network, snapshots, log sources, notes, accounts, settings', () => {
  fresh();
  const res = applyConfig(example, { codeFolder: '/work/pets' });
  const p = res.project, req = (folder, name) => p.folders.find((f) => f.name === folder).requests.find((r) => r.name === name);
  const src = DB.tokenSources[0];
  assert.deepEqual([src.name, src.method, src.url, src.tokenPath, src.body.type], ['Pet Store client credentials', 'POST', '{{authUrl}}/oauth/token', 'access_token', 'form']);
  assert.deepEqual(src.body.form.map((r) => r.k), ['grant_type', 'client_id', 'client_secret']);
  assert.deepEqual(p.folders[2].auth, { type: 'token', sourceId: src.id });
  assert.equal(p.actuatorBase, 'http://localhost:8080/actuator');
  assert.deepEqual(p.logWatch, { levels: true, patterns: 'Timeout, /payment .* failed/i', notify: true });
  assert.equal(p.scripts.pre, "request.headers['X-Client'] = 'api-workbench';");
  const staging = p.envs[1];
  assert.equal(staging.network.caFile, '/work/pets/certs/staging-ca.pem');
  assert.deepEqual(staging.vars.find((v) => v.k === 'debug'), { k: 'debug', v: 'true', on: false });
  assert.deepEqual(staging.vars.find((v) => v.k === 'clientSecret'), { k: 'clientSecret', v: '', on: true, secret: true });
  const create = req('Pets', 'Create pet');
  assert.deepEqual(create.headers, [{ k: 'Idempotency-Key', v: '{{$uuid}}', on: true }, { k: 'X-Debug', v: '1', on: false }]);
  assert.equal(create.options.timeoutSec, 10);
  const get = req('Pets', 'Get pet');
  assert.deepEqual([get.snapshot.status, JSON.parse(get.snapshot.body).name, get.snapshot.ignore], [200, 'Rex', ['updatedAt']]);
  assert.deepEqual(res.links.map((l) => l.operation), ['GET /pets', 'getPetById']);
  const grpc = req('Other protocols', 'Get pet (gRPC)');
  assert.deepEqual([grpc.kind, grpc.grpc.protoFile, grpc.grpc.includeDirs, JSON.parse(grpc.body.text).id], ['grpc', '/work/pets/src/main/proto/pets.proto', '/work/pets/src/main/proto', 1]);
  assert.equal(req('Other protocols', 'Pets (GraphQL)').graphql.variables, '{\n  "limit": 5\n}');
  assert.equal(req('Other protocols', 'Pet events (SSE)').kind, 'sse');
  const [, ssh, k8s, docker] = p.logSources;
  assert.deepEqual([ssh.type, ssh.ssh.host, ssh.ssh.user, ssh.ssh.paths], ['ssh', 'app-1.staging.example.com', 'deploy', '/var/log/pet-store/*.log']);
  assert.deepEqual([k8s.type, k8s.k8s.context, k8s.k8s.namespace, k8s.k8s.selector], ['kubernetes', 'staging', 'pets', 'app=pet-store']);
  assert.deepEqual([docker.type, docker.docker.container], ['docker', 'pet-store-db']);
  assert.deepEqual([DB.notes[0].title, DB.notes[0].projectId, DB.notes[0].tags], ['Pet Store: running locally', p.id, ['setup']]);
  assert.deepEqual(res.accounts, [{ label: 'Admin', user: 'admin@example.com', env: 'local' }]);
  assert.equal(res.settings, true);
  assert.deepEqual([DB.settings.layout.sideOpen, DB.settings.otel.autoStart, DB.settings.aiPrompt.commitAuthors, DB.settings.aiPrompt.logs], [true, true, false, true]);
  assert.equal(DB.settings.ai, undefined, 'AI assistance is never switched on by a file');
});

test('apply warnings: unknown token source, snapshot ignore without a body, passphrase never applied', () => {
  fresh();
  const res = applyConfig({ environments: [{ name: 'x', network: { passphrase: 'pw', insecure: true } }],
    requests: [{ name: 'a', auth: { type: 'token', source: 'Nope' } }, { name: 'b', snapshot: { ignore: ['id'] } }] });
  assert.equal(res.project.envs[0].network.passphrase, '');
  assert.equal(res.project.envs[0].network.insecure, true);
  assert.deepEqual(res.warnings, ['Request "a": no token source "Nope"', 'Request "b": snapshot.ignore needs an expected body (snapshot.json or snapshot.body), or a snapshot saved in the app']);
});

test('linkOperations links by METHOD /path or operationId and reports unknown ones', () => {
  fresh();
  const res = applyConfig({ project: { name: 'P' }, requests: [{ name: 'a', operation: 'get /pets' }, { name: 'b', operation: 'getPet' }, { name: 'c', operation: 'DELETE /nope' }] });
  const p = res.project;
  p.specs.push({ id: 's1', source: { location: 'x' } });
  const ops = [{ key: 'GET /pets', operationId: 'listPets' }, { key: 'GET /pets/{id}', operationId: 'getPet' }];
  const warnings = linkOperations(p, res.links, (id) => (id === 's1' ? { byKey: new Map(ops.map((o) => [o.key, o])), operations: ops } : null));
  assert.deepEqual(p.requests.map((r) => r.spec), [{ specId: 's1', opKey: 'GET /pets' }, { specId: 's1', opKey: 'GET /pets/{id}' }, null]);
  assert.deepEqual(warnings, ['Request "c": no operation "DELETE /nope" in the attached specs']);
});

test('exportConfig round-trips: export → schema-valid → apply → same export', () => {
  fresh();
  const p = applyConfig(example, { codeFolder: '/work/pets' }).project;
  p.specs.push({ id: 's1', source: { location: '/work/pets/src/main/resources/openapi.yaml' } });
  p.folders[1].requests[1].spec = { specId: 's1', opKey: 'GET /pets/{petId}' };
  const accounts = [{ label: 'Admin', user: 'admin@example.com', env: 'local' }];
  const first = exportConfig(p, { accounts, settings: true });
  assert.deepEqual(validateSchema(schema, first.config, { root: schema }), []);
  assert.deepEqual(first.warnings, []);
  assert.equal(first.config.specs[0], 'src/main/resources/openapi.yaml');
  assert.equal(first.config.folders[3].requests[1].grpc.proto, 'src/main/proto/pets.proto');
  assert.equal(first.config.environments[1].network.caFile, 'certs/staging-ca.pem');
  assert.equal(first.config.folders[1].requests[1].operation, 'GET /pets/{petId}');

  fresh();
  const again = applyConfig(structuredClone(first.config), { codeFolder: '/work/pets' }).project;
  again.specs.push({ id: 's2', source: { location: '/work/pets/src/main/resources/openapi.yaml' } });
  again.folders[1].requests[1].spec = { specId: 's2', opKey: 'GET /pets/{petId}' };
  const second = exportConfig(again, { accounts, settings: true });
  assert.deepEqual(second.config, first.config);
});

test('exportConfig never writes secret values', () => {
  fresh();
  const p = applyConfig({ project: { name: 'S', auth: { type: 'bearer', token: 'eyJliteral' } }, environments: [{ name: 'e', variables: { key: { secret: true } } }], requests: [{ name: 'r', auth: { type: 'basic', user: 'u', pass: 'hunter2' } }] }).project;
  p.envs[0].vars[0].v = 'typed-in-secret'; p.envs[0].network.passphrase = 'pfx-pass'; p.cookies = 'sid=abc';
  const { config, warnings } = exportConfig(p);
  const text = JSON.stringify(config);
  for (const secret of ['eyJliteral', 'hunter2', 'typed-in-secret', 'pfx-pass', 'sid=abc']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(config.environments[0].variables, { key: { secret: true } });
  assert.deepEqual(config.requests[0].auth, { type: 'basic', user: 'u', pass: '' });
  assert.equal(warnings.length, 3);
});

test('importing only chosen requests (and the token sources they use)', () => {
  assert.deepEqual(configRequestPaths(example), ['Auth/Log in', 'Pets/List pets', 'Pets/Get pet', 'Pets/Create pet', 'Admin/Pet stats', 'Other protocols/Pets (GraphQL)', 'Other protocols/Get pet (gRPC)', 'Other protocols/Pet updates (WebSocket)', 'Other protocols/Pet events (SSE)']);
  const part = requestsOnly(example, ['Pets/Get pet', 'Admin/Pet stats']);
  assert.deepEqual(part.folders.map((f) => [f.name, f.requests.map((r) => r.name)]), [['Pets', ['Get pet']], ['Admin', ['Pet stats']]]);
  assert.deepEqual(part.tokenSources.map((t) => t.name), ['Pet Store client credentials']);
  assert.deepEqual(validateSchema(schema, part, { root: schema }), []);
  fresh();
  const target = applyConfig({ project: { name: 'Mine' } }).project;
  target.codeFolder = '/my/code';
  const res = applyConfig(part, { project: target, codeFolder: '/elsewhere', adoptCodeFolder: false });
  assert.equal(res.project.codeFolder, '/my/code');
  assert.deepEqual(target.folders.map((f) => f.name), ['Pets', 'Admin']);
  assert.equal(target.envs.length, 0);
  assert.deepEqual(DB.settings.aiPrompt, AI_PROMPT_DEFAULTS);
});
