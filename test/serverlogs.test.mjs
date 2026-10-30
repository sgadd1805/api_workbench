// Server log sources: tail commands, quoting, remote grep (run here through sh), local and kubectl search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const sl = require('../main/serverlogs.js');

const LOG = [
  '2026-10-29 10:00:01 INFO  Started PetApplication',
  '2026-10-29 10:00:02 INFO  GET /pets rid=abc123',
  '2026-10-29 10:00:03 ERROR Request failed rid=req-42 it\'s "bad"',
  'java.lang.IllegalStateException: boom',
  '\tat com.example.Pets.get(Pets.java:42)',
  '2026-10-29 10:00:04 INFO  GET /pets rid=def456',
  '2026-10-29 10:00:05 WARN  slow rid=req-42',
].join('\n') + '\n';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srvlogs-'));
  fs.writeFileSync(path.join(dir, 'app.log'), LOG);
  fs.writeFileSync(path.join(dir, 'app.log.1.gz'), zlib.gzipSync('2026-10-28 23:59:59 ERROR old failure rid=req-42\n'));
  return dir;
}

test('tail commands: ssh, kubernetes (target / selector), docker; bad values rejected', () => {
  const ssh = sl.tailCommand({ type: 'ssh', ssh: { host: 'api-1.prod', user: 'deploy', port: '2222', identityFile: '/k/id', paths: "/var/log/app/*.log, /tmp/it's here.log" } });
  assert.equal(ssh.exe, 'ssh');
  assert.deepEqual(ssh.args.slice(0, 6), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30']);
  assert.deepEqual(ssh.args.slice(6, 11), ['-p', '2222', '-i', '/k/id', 'deploy@api-1.prod']);
  assert.equal(ssh.args.at(-1), "tail -n 200 -F /var/log/app/*.log '/tmp/it'\\''s here.log'");
  const k1 = sl.tailCommand({ type: 'kubernetes', k8s: { context: 'stage', namespace: 'pets', target: 'deploy/pets', container: 'app' } });
  assert.deepEqual([k1.exe, ...k1.args], ['kubectl', '--context', 'stage', '-n', 'pets', 'logs', '-f', '--tail=200', 'deploy/pets', '-c', 'app']);
  const k2 = sl.tailCommand({ type: 'kubernetes', k8s: { selector: 'app=pets' } });
  assert.deepEqual(k2.args, ['logs', '-f', '--tail=200', '-l', 'app=pets', '--prefix', '--max-log-requests=20', '--all-containers']);
  assert.deepEqual(sl.tailCommand({ type: 'docker', docker: { container: 'pets' } }).args, ['logs', '-f', '--tail', '200', 'pets']);
  assert.throws(() => sl.tailCommand({ type: 'ssh', ssh: { host: '-oProxyCommand=evil', paths: '/x' } }), /can't start with "-"/);
  assert.throws(() => sl.tailCommand({ type: 'ssh', ssh: { host: 'a b', paths: '/x' } }), /characters/);
  assert.throws(() => sl.tailCommand({ type: 'kubernetes', k8s: { target: '--kubeconfig=/x' } }), /can't start/);
  assert.throws(() => sl.tailCommand({ type: 'ssh', ssh: { host: 'h' } }), /path/);
  assert.equal(sl.shq("a'b"), "'a'\\''b'");
});

test('remote grep script (run locally with sh): plain + .gz files, globs, context, quoting', () => {
  const dir = fixture();
  const q = sl.normalizeQuery({ pattern: 'req-42', context: 1, max: 50 });
  const script = sl.remoteGrepScript([path.join(dir, 'app.log*')], q);
  const out = execFileSync('sh', ['-c', script], { encoding: 'utf8' });
  const { hits } = sl.parseGrep(out, q);
  assert.deepEqual(hits.map((h) => [path.basename(h.file), h.line]), [['app.log', 3], ['app.log', 7], ['app.log.1.gz', 1]]);
  assert.deepEqual(hits[0].before, [{ line: 2, text: '2026-10-29 10:00:02 INFO  GET /pets rid=abc123' }]);
  assert.equal(hits[0].after[0].text, 'java.lang.IllegalStateException: boom');
  // A pattern with quotes and shell characters is searched literally, not executed.
  const q2 = sl.normalizeQuery({ pattern: `it's "bad"; $(touch ${dir}/pwned)` });
  execFileSync('sh', ['-c', sl.remoteGrepScript([path.join(dir, 'app.log')], q2)], { encoding: 'utf8' });
  assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
  const q3 = sl.normalizeQuery({ pattern: 'ERROR.*rid=req', regex: true, ignoreCase: true });
  const r3 = sl.parseGrep(execFileSync('sh', ['-c', sl.remoteGrepScript([path.join(dir, '*.log'), path.join(dir, '*.gz')], q3)], { encoding: 'utf8' }), q3);
  assert.equal(r3.hits.length, 2);
});

test('search: local files (glob, gz, context, max) and kubectl through a stand-in binary', async (t) => {
  const dir = fixture();
  let r = await sl.search('s1', { type: 'file', path: path.join(dir, 'app.log*') }, { pattern: 'rid=req-42', context: 2 });
  assert.deepEqual(r.hits.map((h) => [path.basename(h.file), h.line]), [['app.log', 3], ['app.log', 7], ['app.log.1.gz', 1]]);
  assert.equal(r.hits[0].after.length, 2);
  r = await sl.search('s2', { type: 'file', path: path.join(dir, 'app.log') }, { pattern: 'INFO', max: 2 });
  assert.equal(r.hits.length, 2); assert.equal(r.truncated, true);
  r = await sl.search('s3', { type: 'file', path: path.join(dir, 'nope*.log') }, { pattern: 'x' });
  assert.match(r.error, /No files match/);
  await assert.rejects(sl.search('s4', { type: 'file', path: dir + '/app.log' }, { pattern: '(', regex: true }), /Bad regular expression/);

  // A fake kubectl that prints prefixed lines and records its arguments.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-'));
  fs.writeFileSync(path.join(bin, 'kubectl'), `#!/bin/sh\necho "$@" > "${bin}/args"\nprintf '[pod/pets-1/app] ok rid=1\\n[pod/pets-2/app] ERROR rid=req-42\\n'\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  r = await sl.search('s5', { type: 'kubernetes', k8s: { namespace: 'pets', selector: 'app=pets' } }, { pattern: 'req-42', since: '1h' });
  assert.deepEqual(r.hits.map((h) => [h.file, h.text]), [['pod/pets-2/app', 'ERROR rid=req-42']]);
  assert.equal(fs.readFileSync(path.join(bin, 'args'), 'utf8').trim(), '-n pets logs --since=1h -l app=pets --prefix --max-log-requests=20 --all-containers');
  r = await sl.search('s6', { type: 'docker', docker: { container: 'pets' } }, { pattern: 'x' });
  assert.ok(r.error === undefined || /docker/.test(r.error)); // docker may not be installed here
});
