// Task runner (start, readiness from logs, port, stop) and log store (stack-trace folding, correlation search).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tasks = require('../main/tasks.js');
const logs = require('../main/logs.js');

test('detect suggests Maven / Gradle / jar commands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-'));
  for (const f of ['mvnw', 'pom.xml', 'build.gradle']) fs.writeFileSync(path.join(dir, f), '');
  fs.mkdirSync(path.join(dir, 'target'));
  for (const j of ['app-1.0.jar', 'app-1.0-plain.jar', 'app-1.0-sources.jar']) fs.writeFileSync(path.join(dir, 'target', j), '');
  const found = tasks.detect(dir).map((d) => d.command);
  const win = process.platform === 'win32';
  assert.deepEqual(found, [win ? 'mvnw.cmd spring-boot:run' : './mvnw spring-boot:run', 'gradle bootRun', `java -jar ${path.join('target', 'app-1.0.jar')}`]);
});

test('childEnv: JAVA_HOME first on PATH, Spring profile, JVM options, extra vars', () => {
  const env = tasks.childEnv({ javaHome: '/jdk21', profile: 'local', jvmOpts: '-Xmx512m', env: [{ k: 'A', v: '1', on: true }, { k: 'B', v: '2', on: false }] });
  assert.equal(env.JAVA_HOME, '/jdk21');
  assert.ok(env.PATH.startsWith(path.join('/jdk21', 'bin') + path.delimiter));
  assert.equal(env.SPRING_PROFILES_ACTIVE, 'local');
  assert.match(env.JAVA_TOOL_OPTIONS, /-Xmx512m$/);
  assert.deepEqual([env.A, env.B], ['1', undefined]);
});

test('a task runs, becomes ready from its log, reports its port, folds stack traces, stops', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-'));
  fs.writeFileSync(path.join(dir, 'fake-server.js'), `
    console.log('  .   ____          _            __ _ _');
    console.log('2026-10-28 INFO  o.s.b.w.e.tomcat.TomcatWebServer : Tomcat started on port 8099 (http)');
    console.log('2026-10-28 INFO  com.example.App : Started App in 1.234 seconds (process running for 1.5)');
    console.log('2026-10-28 INFO  [req=abc-123-def-456] GET /pets/1');
    console.error('2026-10-28 ERROR [req=abc-123-def-456] Request failed');
    console.error('java.lang.IllegalStateException: boom');
    console.error('\\tat com.example.PetService.find(PetService.java:42)');
    console.error('\\tat com.example.PetController.get(PetController.java:17)');
    console.error('Caused by: java.sql.SQLException: no connection');
    console.error('\\t... 12 more');
    console.log('2026-10-28 WARN  unrelated');
    setInterval(() => {}, 1000);`);
  const def = { id: 'task-1', name: 'Fake', command: `"${process.execPath}" fake-server.js`, cwd: dir, env: [], shell: 'sh' };
  assert.equal(tasks.start(def).ok, true);
  assert.equal(tasks.start(def).ok, false); // already running
  const t0 = Date.now();
  while (tasks.stateOf('task-1').state !== 'ready' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
  assert.equal(tasks.stateOf('task-1').state, 'ready');
  assert.equal(tasks.stateOf('task-1').port, 8099);
  await new Promise((r) => setTimeout(r, 300));
  const found = logs.findLines(['task-1'], ['abc-123-def-456']);
  assert.equal(found.length, 1);
  // The ERROR line comes with its exception and stack trace.
  assert.deepEqual(found[0].lines.map((l) => l.text.trim().slice(0, 31)), [
    '2026-10-28 INFO  [req=abc-123-d', '2026-10-28 ERROR [req=abc-123-d', 'java.lang.IllegalStateException',
    'at com.example.PetService.find(', 'at com.example.PetController.ge', 'Caused by: java.sql.SQLExceptio', '... 12 more']);
  const all = logs.linesSince('task-1');
  const exception = all.findIndex((l) => l.text.startsWith('java.lang.IllegalStateException'));
  assert.deepEqual(all.slice(exception, exception + 5).map((l) => l.cont), [true, true, true, true, true]); // folded under the ERROR line
  assert.equal(all.find((l) => l.text.includes('unrelated')).cont, false);
  assert.equal(all.find((l) => l.text.includes('ERROR')).level, 'ERROR');
  assert.equal(all.find((l) => l.text.includes('unrelated')).level, 'WARN');
  tasks.stop('task-1');
  const t1 = Date.now();
  while (tasks.stateOf('task-1').state !== 'stopped' && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 50));
  assert.equal(tasks.stateOf('task-1').state, 'stopped');
  assert.match(logs.linesSince('task-1').at(-1).text, /■ exited/);
});

test('a failing task is marked failed; health-URL readiness', { skip: process.platform === 'win32' }, async (t) => {
  const http = await import('node:http');
  const server = http.createServer((_q, res) => res.end('UP'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  assert.equal(tasks.start({ id: 'task-2', name: 'Crash', command: 'echo starting; exit 3', cwd: os.tmpdir(), env: [], shell: 'sh' }).ok, true);
  const t0 = Date.now();
  while (tasks.stateOf('task-2').state === 'starting' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([tasks.stateOf('task-2').state, tasks.stateOf('task-2').exitCode], ['failed', 3]);
  tasks.start({ id: 'task-3', name: 'Health', command: 'sleep 30', cwd: os.tmpdir(), env: [], shell: 'sh', readyLog: 'never-printed', readyUrl: `http://127.0.0.1:${server.address().port}/health` });
  const t1 = Date.now();
  while (tasks.stateOf('task-3').state !== 'ready' && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 50));
  assert.equal(tasks.stateOf('task-3').state, 'ready');
  tasks.stop('task-3');
});

test('log source: tail a file from its end, follow appends, handle truncation', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tail-')), 'app.log');
  fs.writeFileSync(file, 'old line\n');
  assert.equal(logs.startSource({ id: 'file-1', name: 'App log', type: 'file', path: file }).ok, true);
  fs.appendFileSync(file, 'new line req=zz-999-yy\n');
  await new Promise((r) => setTimeout(r, 800));
  assert.deepEqual(logs.linesSince('file-1').map((l) => l.text), ['old line', 'new line req=zz-999-yy']);
  fs.writeFileSync(file, 'after rotate\n');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(logs.linesSince('file-1').at(-1).text, 'after rotate');
  assert.equal(logs.findLines(['file-1', 'nope'], ['zz-999-yy'])[0].lines.length, 1);
  logs.stopSource('file-1');
  assert.match(logs.startSource({ id: 'file-2', name: 'x', type: 'file', path: '/no/such.log' }).error, /File not found/);
});
