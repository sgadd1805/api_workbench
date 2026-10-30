// Windows support: paths as Windows writes them, file names Windows refuses, commands for cmd / PowerShell,
// and replacing data files while another program briefly holds them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

globalThis.window = { electronAPI: { storageSet() {} } };
const require = createRequire(import.meta.url);
const { joinPath, relPath, isAbsPath } = await import('../renderer/shared/paths.js');
const { DB, addProject, addFolder, addRequest, newReq, normalizeDB } = await import('../renderer/app/store.js');
const { toRepo, fromRepo } = await import('../renderer/app/repo.js');
const { applyConfig, exportConfig } = await import('../renderer/app/config.js');
const { forWindowsShell, shellCommand } = require('../main/terminal.js');
const { replaceFile } = require('../main/fsutil.js');

test('paths: Windows forms are absolute, joined with backslashes, made relative case-insensitively', () => {
  for (const p of ['C:\\code', 'c:/code', '\\\\server\\share\\x', '/home/me', 'https://x/api-docs']) assert.ok(isAbsPath(p), p);
  for (const p of ['proto/x.proto', '.\\certs\\ca.pem', '~/.ssh/id']) assert.ok(!isAbsPath(p), p);
  assert.equal(joinPath('C:\\code\\pets', 'proto/pets.proto'), 'C:\\code\\pets\\proto\\pets.proto');
  assert.equal(joinPath('C:\\code\\pets\\', './certs/ca.pem'), 'C:\\code\\pets\\certs\\ca.pem');
  assert.equal(joinPath('/work/pets', 'logs\\app.log'), '/work/pets/logs/app.log');
  assert.equal(joinPath('C:\\code', 'D:\\other\\x.proto'), 'D:\\other\\x.proto');
  assert.equal(relPath('C:\\Code\\Pets', 'c:\\code\\pets\\proto\\pets.proto'), 'proto/pets.proto');
  assert.equal(relPath('C:/code/pets', 'C:\\code\\pets\\certs\\ca.pem'), 'certs/ca.pem');
  assert.equal(relPath('C:\\code\\pets', 'C:\\code\\petshop\\x.proto'), 'C:\\code\\petshop\\x.proto');
  assert.equal(relPath('/work/Pets', '/work/pets/x'), '/work/pets/x', 'macOS / Linux paths stay case-sensitive');
});

test('request files from a Windows code folder: relative "/" paths, no device names', () => {
  DB.projects = [];
  const p = addProject('Pets');
  p.codeFolder = 'C:\\Users\\me\\code\\pets';
  const f = addFolder(p, 'Aux');
  const r = addRequest(p, f, newReq({ name: 'CON', kind: 'grpc' }));
  r.grpc = { protoFile: 'C:\\Users\\me\\code\\pets\\proto\\pets.proto', includeDirs: '', service: 's', method: 'm' };
  addRequest(p, null, newReq({ name: 'com1' }));
  const out = toRepo(p);
  assert.deepEqual(out.files.map((x) => x.rel), ['com1-.request.yaml', 'aux-/con-.request.yaml']);
  assert.equal(out.files[1].data.grpc.protoFile, 'proto/pets.proto');
  // Loading the files back on a teammate's Windows machine resolves against their folder.
  const q = addProject('Pets 2');
  q.codeFolder = 'D:\\src\\pets';
  fromRepo(q, { project: out.project, requests: out.files.map((x) => ({ rel: x.rel, data: x.data })) });
  const grpc = q.folders.flatMap((x) => x.requests).find((x) => x.kind === 'grpc').grpc;
  assert.equal(grpc.protoFile, 'D:\\src\\pets\\proto\\pets.proto');
});

test('api-client.json on Windows: relative paths applied with backslashes, exported with "/"', () => {
  Object.assign(DB, { projects: [], features: [], notes: [], tokenSources: [], settings: {} });
  normalizeDB(DB);
  const cfg = { project: { name: 'W' }, environments: [{ name: 'e', network: { caFile: 'certs/ca.pem' } }],
    requests: [{ name: 'g', kind: 'grpc', grpc: { proto: 'proto/x.proto', includeDirs: ['proto'], service: 's', method: 'm' } }],
    logSources: [{ name: 'l', type: 'file', path: 'logs/app.log' }], specs: ['api/openapi.yaml'] };
  const res = applyConfig(cfg, { codeFolder: 'C:\\code\\w' });
  const p = res.project;
  assert.equal(p.envs[0].network.caFile, 'C:\\code\\w\\certs\\ca.pem');
  assert.equal(p.requests[0].grpc.protoFile, 'C:\\code\\w\\proto\\x.proto');
  assert.equal(p.requests[0].grpc.includeDirs, 'C:\\code\\w\\proto');
  assert.equal(p.logSources[0].path, 'C:\\code\\w\\logs\\app.log');
  assert.deepEqual(res.specs, ['C:\\code\\w\\api\\openapi.yaml']);
  p.specs.push({ id: 's', source: { location: res.specs[0] } });
  const { config } = exportConfig(p);
  assert.deepEqual([config.environments[0].network.caFile, config.requests[0].grpc.proto, config.requests[0].grpc.includeDirs, config.logSources[0].path, config.specs[0]],
    ['certs/ca.pem', 'proto/x.proto', ['proto'], 'logs/app.log', 'api/openapi.yaml']);
});

test('commands written for macOS / Linux run under cmd and PowerShell', () => {
  assert.equal(forWindowsShell('cmd', './mvnw spring-boot:run'), 'mvnw.cmd spring-boot:run');
  assert.equal(forWindowsShell('powershell', './mvnw spring-boot:run'), '.\\mvnw.cmd spring-boot:run');
  assert.equal(forWindowsShell('cmd', './gradlew bootRun'), 'gradlew.bat bootRun');
  assert.equal(forWindowsShell('pwsh', '  ./gradlew bootRun'), '  .\\gradlew.bat bootRun');
  assert.equal(forWindowsShell('cmd', './start.sh --port 1'), '.\\start.sh --port 1');
  assert.equal(forWindowsShell('cmd', 'java -jar target/app.jar ./x'), 'java -jar target/app.jar ./x');
  assert.deepEqual(shellCommand('cmd', './mvnw test'), ['cmd.exe', ['/d', '/s', '/c', '"mvnw.cmd test"'], { windowsVerbatimArguments: true }]);
  assert.equal(shellCommand('powershell', './gradlew build')[1].at(-1), '.\\gradlew.bat build');
  assert.equal(shellCommand('gitbash', './mvnw test')[1].at(-1), './mvnw test', 'Git Bash runs the Unix wrapper');
});

test('replaceFile retries a rename another program blocks, then writes in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-'));
  const file = path.join(dir, 'db.json');
  fs.writeFileSync(file, 'old');
  let calls = 0;
  const busyTwice = (a, b) => { if (++calls <= 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); fs.renameSync(a, b); };
  replaceFile(file, 'new', { rename: busyTwice });
  assert.equal(fs.readFileSync(file, 'utf8'), 'new'); assert.equal(calls, 3);
  replaceFile(file, 'newer', { rename: () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); } });
  assert.equal(fs.readFileSync(file, 'utf8'), 'newer');
  assert.ok(!fs.existsSync(file + '.tmp'));
  assert.throws(() => replaceFile(path.join(dir, 'missing', 'x.json'), 'x'), /ENOENT/);
});
