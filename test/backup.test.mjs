// Full backup and selective restore (renderer/app/backup.js), and the files a backup carries (main/backup.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import example from '../docs/examples/api-client.json' with { type: 'json' };

globalThis.window = { electronAPI: { storageSet() {} } };
const { DB, normalizeDB, allRequests } = await import('../renderer/app/store.js');
const { applyConfig } = await import('../renderer/app/config.js');
const { buildBackup, parseBackup, backupContents, restoreBackup, filesWanted, historyToRestore, restoredPathFor, BACKUP_FORMAT, encryptBackup, decryptBackup, isEncryptedBackup } = await import('../renderer/app/backup.js');
const { readFiles } = createRequire(import.meta.url)('../main/backup.js');

// The example project with secrets typed in, a spec, a feature, a global note and session-only settings.
function setup() {
  Object.assign(DB, { projects: [], features: [], notes: [], tokenSources: [], settings: { openTabs: ['x'], activeTab: 'x', termHistory: ['export TOKEN=abc'] } });
  normalizeDB(DB);
  const p = applyConfig(example, { codeFolder: '/work/pets' }).project;
  p.envs[0].vars.find((v) => v.k === 'token').v = 'live-token';
  p.cookies = 'sid=abc';
  p.folders[0].requests[0].auth = { type: 'bearer', token: 'literal-bearer' };
  p.specs.push({ id: 'spec1', title: 'Pets', source: { type: 'file', location: '/work/pets/openapi.yaml' } });
  p.folders[1].requests[1].spec = { specId: 'spec1', opKey: 'GET /pets/{petId}' };
  DB.tokenSources[0].body.form.find((r) => r.k === 'client_secret').v = 'raw-secret';
  DB.notes.push({ id: 'g', title: 'Global', body: 'hi', tags: [], projectId: null });
  return p;
}

test('buildBackup: complete data, session state dropped, secrets blanked unless asked', () => {
  setup();
  const b = buildBackup({ specs: { spec1: { openapi: '3.0.0' } }, accounts: [{ label: 'Admin', user: 'a', env: 'local', pass: 'pw', totp: 'T' }], files: { '/f': 'eA==' }, now: Date.UTC(2026, 9, 29) });
  assert.equal(b.format, BACKUP_FORMAT); assert.equal(b.createdAt, '2026-10-29T00:00:00.000Z'); assert.equal(b.secrets, false);
  assert.equal(b.data.projects[0].folders.length, 4); assert.equal(b.data.notes.length, 2); assert.equal(b.data.features.length, 1);
  assert.deepEqual(Object.keys(b.specs), ['spec1']);
  for (const k of ['openTabs', 'activeTab', 'termHistory']) assert.ok(!(k in b.data.settings), k);
  const text = JSON.stringify(b);
  for (const secret of ['live-token', 'sid=abc', 'literal-bearer', 'raw-secret', '"pw"', '"T"']) assert.ok(!text.includes(secret), secret);
  assert.equal(b.data.tokenSources[0].body.form.find((r) => r.k === 'client_id').v, '{{clientId}}');
  assert.ok(!('history' in b));
  const withSecrets = JSON.stringify(buildBackup({ accounts: [{ label: 'Admin', user: 'a', pass: 'pw' }], includeSecrets: true, history: [] }));
  for (const secret of ['live-token', 'sid=abc', 'literal-bearer', 'raw-secret', '"pw"']) assert.ok(withSecrets.includes(secret), secret);
  assert.equal(DB.projects[0].cookies, 'sid=abc', 'the live data is untouched');
});

test('filesWanted: certificates and .proto files with include folders', () => {
  const p = setup();
  assert.deepEqual(filesWanted([p]), { paths: ['/work/pets/certs/staging-ca.pem'], protos: [{ file: '/work/pets/src/main/proto/pets.proto', includeDirs: ['/work/pets/src/main/proto'] }] });
});

test('parseBackup and backupContents', () => {
  setup();
  const b = buildBackup({ includeSecrets: true });
  assert.throws(() => parseBackup('nope'), /Not a JSON file/);
  assert.throws(() => parseBackup('{"format":"api-workbench-collection","project":{}}'), /Not an API Workbench backup/);
  assert.throws(() => parseBackup(JSON.stringify({ ...b, version: 2 })), /newer/);
  const c = backupContents(parseBackup(JSON.stringify(b)));
  assert.deepEqual(c.projects.map((p) => [p.name, p.requests, p.exists]), [['Pet Store', 9, true]]);
  assert.deepEqual([c.tokenSources, c.notes, c.features, c.settings, c.secrets], [1, 2, 1, true, true]);
});

test('restore "keep both": fresh ids, references follow, nothing of the original changes', () => {
  const p = setup();
  const b = JSON.parse(JSON.stringify(buildBackup({ specs: { spec1: { openapi: '3.0.0' } }, includeSecrets: true })));
  const before = JSON.stringify(p);
  const { summary, specDocs, idMap } = restoreBackup(b, { projects: [p.id], sameName: 'keep', tokenSources: true, notes: true, features: true, settings: false });
  assert.equal(JSON.stringify(p), before);
  const q = DB.projects[1];
  assert.equal(q.name, 'Pet Store (restored)');
  assert.notEqual(q.id, p.id);
  assert.equal(q.activeEnv, q.envs[0].id);
  assert.ok(allRequests(q).every((r) => !allRequests(p).some((o) => o.id === r.id)));
  assert.equal(idMap.size, 9);
  const linked = q.folders[1].requests[1].spec;
  assert.deepEqual(specDocs, [{ id: linked.specId, doc: { openapi: '3.0.0' } }]);
  assert.equal(q.specs[0].id, linked.specId);
  assert.equal(q.folders[2].auth.sourceId, DB.tokenSources[0].id);
  assert.equal(DB.tokenSources.length, 1);
  assert.deepEqual(DB.features[0].requestIds.length, 6, 'the feature now holds the original and the restored requests');
  assert.deepEqual(DB.notes.filter((n) => n.projectId === q.id).map((n) => n.title), ['Pet Store: running locally']);
  assert.equal(DB.notes.filter((n) => n.title === 'Global').length, 1, 'identical notes are not duplicated');
  assert.equal(summary.projects, 1); assert.equal(summary.requests, 9);
  restoreBackup(b, { projects: [p.id], sameName: 'keep' });
  assert.equal(DB.projects[2].name, 'Pet Store (restored 2)');
});

test('restore "replace": the same-named project is swapped, its notes kept; settings keep this session', () => {
  const p = setup();
  const b = JSON.parse(JSON.stringify(buildBackup({ includeSecrets: false })));
  DB.notes.push({ id: 'mine', title: 'Mine', body: '', tags: [], projectId: p.id });
  b.data.settings.theme = 'light';
  const { summary } = restoreBackup(b, { projects: [p.id], sameName: 'replace', settings: true, features: true });
  assert.equal(DB.projects.length, 1);
  const q = DB.projects[0];
  assert.equal(q.name, 'Pet Store'); assert.notEqual(q.id, p.id);
  assert.equal(DB.notes.find((n) => n.id === 'mine').projectId, q.id);
  assert.equal(DB.features[0].requestIds.length, 3);
  assert.ok(DB.features[0].requestIds.every((id) => allRequests(q).some((r) => r.id === id)));
  assert.equal(DB.settings.theme, 'light'); assert.deepEqual(DB.settings.openTabs, ['x']);
  assert.equal(q.envs[0].vars.find((v) => v.k === 'token').v, '', 'no secrets in this backup');
  assert.deepEqual(summary, { 'projects replaced': 1, requests: 9, 'app settings': 1 });
});

test('restore relinks requests to files copied into the app folder', () => {
  const p = setup();
  const b = buildBackup({ includeSecrets: true });
  const root = '/data/restored-files';
  const moved = { '/work/pets/src/main/proto/pets.proto': restoredPathFor(root, '/work/pets/src/main/proto/pets.proto'), '/work/pets/certs/staging-ca.pem': restoredPathFor(root, '/work/pets/certs/staging-ca.pem') };
  restoreBackup(b, { projects: [p.id], sameName: 'keep' }, { moved, root });
  const q = DB.projects[1];
  const grpc = q.folders[3].requests[1].grpc;
  assert.equal(grpc.protoFile, '/data/restored-files/work/pets/src/main/proto/pets.proto');
  assert.equal(grpc.includeDirs, '/data/restored-files/work/pets/src/main/proto');
  assert.equal(q.envs[1].network.caFile, '/data/restored-files/work/pets/certs/staging-ca.pem');
  assert.equal(restoredPathFor('C:\\data\\rf', 'D:\\x\\..\\y.pem'), 'C:\\data\\rf\\x\\y.pem');
});

test('historyToRestore: only new entries, oldest first, request ids remapped', () => {
  const b = { history: [{ id: 'h2', reqId: 'r1', at: 2 }, { id: 'h1', reqId: 'gone', at: 1 }, { id: 'h0', reqId: 'r1', at: 0 }] };
  const out = historyToRestore(b, new Map([['r1', 'n1']]), [{ id: 'h0' }]);
  assert.deepEqual(out.map((e) => [e.id, e.reqId]), [['h1', null], ['h2', 'n1']]);
});

test('main/backup.js readFiles: certificates, .proto imports followed, missing and well-known types skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const write = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  const main = write('proto/pets.proto', 'syntax = "proto3";\nimport "common/types.proto";\nimport public "google/protobuf/timestamp.proto";\nimport "missing.proto";\n');
  const types = write('shared/common/types.proto', 'syntax = "proto3";\nimport "proto/pets.proto";\n');
  const ca = write('certs/ca.pem', 'CA');
  const res = readFiles({ paths: [ca, path.join(dir, 'nope.pem')], protos: [{ file: main, includeDirs: [path.join(dir, 'shared'), dir] }] });
  assert.deepEqual(Object.keys(res.files).sort(), [ca, main, types].sort());
  assert.equal(Buffer.from(res.files[ca], 'base64').toString(), 'CA');
  assert.deepEqual(res.missing, [path.join(dir, 'nope.pem')]);
});

test('password-protected backups: AES-256-GCM with a PBKDF2 key; wrong password or tampering is refused', async () => {
  setup();
  const b = buildBackup({ includeSecrets: true });
  const file = JSON.stringify(await encryptBackup(b, 'correct horse battery', { iterations: 1000 }));
  assert.equal(isEncryptedBackup(file), true);
  assert.equal(isEncryptedBackup(JSON.stringify(b)), false);
  for (const secret of ['live-token', 'sid=abc', 'Pet Store']) assert.ok(!file.includes(secret), secret);
  const meta = JSON.parse(file).encrypted;
  assert.deepEqual([meta.cipher, meta.kdf, meta.iterations, atob(meta.salt).length, atob(meta.iv).length], ['AES-256-GCM', 'PBKDF2-SHA256', 1000, 16, 12]);
  const back = parseBackup(await decryptBackup(file, 'correct horse battery'));
  assert.deepEqual(back, JSON.parse(JSON.stringify(b)));
  await assert.rejects(decryptBackup(file, 'wrong'), /Wrong password/);
  const tampered = JSON.parse(file); tampered.encrypted.data = btoa('x' + atob(tampered.encrypted.data).slice(1));
  await assert.rejects(decryptBackup(JSON.stringify(tampered), 'correct horse battery'), /Wrong password, or the backup file is damaged/);
  await assert.rejects(encryptBackup(b, ''), /password is needed/);
  const again = JSON.parse(JSON.stringify(await encryptBackup(b, 'correct horse battery', { iterations: 1000 })));
  assert.notEqual(again.encrypted.salt, meta.salt, 'a fresh salt and IV each time');
});
