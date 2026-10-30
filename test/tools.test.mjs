// Transport timing + exact headers, git history, terminal, API search, docs helpers, markdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { searchItems, searchApi } from '../renderer/app/search.js';
import { defaultTerms } from '../renderer/app/git.js';
import { fieldRows, typeLabel, constraintsOf } from '../renderer/app/openapi/docs.js';
import { analyzeSpec } from '../renderer/app/openapi/spec.js';
import { markdown } from '../renderer/shared/markdown.js';

const require = createRequire(import.meta.url);
const { proxyFetch } = require('../main/http.js');
const { requestHistory, show } = require('../main/git.js');
const terminal = require('../main/terminal.js');

test('transport: only the request\'s headers plus defaults; gzip; redirects; timing', async (t) => {
  let lastHeaders = null;
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      lastHeaders = req.rawHeaders;
      if (req.url === '/gz') { res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain' }); return res.end(zlib.gzipSync('zipped body')); }
      if (req.url === '/see-other') { res.writeHead(303, { Location: '/landed' }); return res.end(); }
      if (req.url === '/elsewhere') { res.writeHead(307, { Location: `http://localhost:${server.address().port}/landed` }); return res.end(); }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, body, headers: req.headers }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const r = await proxyFetch({ url: base + '/x', method: 'POST', headers: { 'X-A': '1', 'User-Agent': 'mine' }, body: 'hi' });
  const names = lastHeaders.filter((_, i) => i % 2 === 0).map((h) => h.toLowerCase());
  assert.deepEqual(names.sort(), ['accept', 'accept-encoding', 'connection', 'content-length', 'host', 'user-agent', 'x-a']);
  assert.ok(!names.some((n) => n.startsWith('sec-') || n === 'accept-language' || n === 'content-type'));
  assert.equal(JSON.parse(r.body).headers['user-agent'], 'mine'); // explicit header wins over the default
  assert.equal(r.sentHeaders['content-length'], '2');
  for (const k of ['dns', 'tcp', 'tls', 'request', 'wait', 'download', 'total']) assert.equal(typeof r.timing[k], 'number', k);
  assert.equal(r.timing.tls, 0);
  assert.equal(r.timing.httpVersion, '1.1');
  const again = await proxyFetch({ url: base + '/y', method: 'GET', headers: {} });
  assert.equal(again.timing.reused, true); // keep-alive connection
  assert.equal(again.timing.dns + again.timing.tcp, 0);

  assert.equal((await proxyFetch({ url: base + '/gz', method: 'GET', headers: {} })).body, 'zipped body');
  const seeOther = await proxyFetch({ url: base + '/see-other', method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'data' });
  assert.deepEqual([JSON.parse(seeOther.body).method, JSON.parse(seeOther.body).body, seeOther.timing.redirects.length, seeOther.timing.redirects[0].status], ['GET', '', 1, 303]);
  const crossOrigin = await proxyFetch({ url: base + '/elsewhere', method: 'GET', headers: { Authorization: 'Bearer secret', 'X-Keep': 'y' } });
  const landed = JSON.parse(crossOrigin.body).headers;
  assert.deepEqual([landed.authorization, landed['x-keep']], [undefined, 'y']); // credentials not carried to another origin
  assert.match((await proxyFetch({ url: 'ftp://x/', method: 'GET', headers: {} })).error, /Unsupported protocol/);
});

const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();

test('git: finds the files defining an endpoint and their commits', { skip: !hasGit && 'git not installed' }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  const g = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'a@x' } });
  g('init', '-q'); g('checkout', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/PetController.java'), '@GetMapping("/pets/{petId}")\npublic Pet getPet() {}\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  g('add', '.'); g('commit', '-q', '-m', 'Add pet endpoint');
  fs.appendFileSync(path.join(repo, 'README.md'), 'more\n'); g('commit', '-qam', 'Docs only');
  fs.appendFileSync(path.join(repo, 'src/PetController.java'), '// validate id\n'); g('commit', '-qam', 'Validate pet id');
  const res = await requestHistory({ folder: path.join(repo, 'src'), terms: ['/pets/{petId}', 'getPet'] });
  assert.equal(res.branch, 'main');
  assert.deepEqual(res.files.map((f) => f.file), ['src/PetController.java']);
  assert.deepEqual(res.files[0].hits.map((h) => [h.term, h.line]), [['/pets/{petId}', 1], ['getPet', 2]]);
  assert.deepEqual(res.commits.map((c) => c.subject), ['Validate pet id', 'Add pet endpoint']); // not "Docs only"
  assert.ok(res.commits[1].reasons.includes('added or removed "/pets/{petId}"'));
  const diff = await show({ folder: repo, hash: res.commits[0].hash, files: ['src/PetController.java'] });
  assert.match(diff.text, /\+\/\/ validate id/);
  await assert.rejects(show({ folder: repo, hash: 'not-a-hash' }), /Bad commit id/);
  await assert.rejects(requestHistory({ folder: os.tmpdir(), terms: ['x'] }), /not a git repository/i);
});

test('terminal: runs in a shell, streams output, cd changes folder, kill stops it', { skip: process.platform === 'win32' }, async () => {
  const msgs = [];
  const sender = { isDestroyed: () => false, send: (ch, p) => msgs.push([ch, p]) };
  const ipc = { handlers: {}, handle(ch, fn) { this.handlers[ch] = fn; } };
  terminal.register(ipc);
  const run = (opts) => ipc.handlers['term-run']({ sender }, opts);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term-')));
  const done = (id) => new Promise((resolve) => { const t = setInterval(() => { const e = msgs.find(([ch, p]) => ch === 'term-exit' && p.id === id); if (e) { clearInterval(t); resolve(e[1]); } }, 20); });
  const out = (id) => msgs.filter(([ch, p]) => ch === 'term-data' && p.id === id).map(([, p]) => p.data).join('');

  assert.equal((await run({ id: 'a', shell: 'sh', command: 'echo "$GREETING from $(pwd)"; echo oops >&2; exit 3', cwd: dir, env: { GREETING: 'hello', PATH: 'ignored' } })).ok, true);
  assert.equal((await done('a')).code, 3);
  assert.equal(out('a'), `hello from ${dir}\noops\n`);
  assert.ok(msgs.some(([ch, p]) => ch === 'term-data' && p.id === 'a' && p.stream === 'stderr'));
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.deepEqual(await run({ id: 'b', shell: 'sh', command: 'cd sub', cwd: dir }), { ok: true, cwd: path.join(dir, 'sub'), done: true });
  assert.match((await run({ id: 'c', shell: 'sh', command: 'cd nope', cwd: dir })).error, /no such directory/);
  await run({ id: 'd', shell: 'sh', command: 'sleep 30', cwd: dir });
  ipc.handlers['term-kill'](null, 'd');
  assert.ok((await done('d')).signal);
  await run({ id: 'e', shell: 'sh', command: 'read line; echo "got $line"', cwd: dir });
  ipc.handlers['term-input'](null, { id: 'e', text: 'abc\n' });
  await done('e');
  assert.equal(out('e'), 'got abc\n');
  assert.ok(terminal.listShells().length >= 1);
});

const SPEC = {
  openapi: '3.0.0', info: { title: 'Search me', version: '1' },
  components: { schemas: { Pet: { type: 'object', required: ['name'], description: 'A pet', properties: { name: { type: 'string', description: 'Pet **name**', example: 'Rex' }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } }, parent: { $ref: '#/components/schemas/Pet' } } } } },
  paths: {
    '/pets/{petId}': { get: { operationId: 'getPetById', summary: 'Find pet by ID', tags: ['pet'], description: 'Returns a single pet, including its vaccination records.', parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'ok' } } } },
    '/store/inventory': { get: { operationId: 'getInventory', summary: 'Returns pet inventories', tags: ['store'], responses: { 200: { description: 'ok' } } } },
    '/users/login': { get: { summary: 'Log in', tags: ['user'], deprecated: true, parameters: [{ name: 'username', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } },
  },
};

test('API search: requests + operations, field weighting, every word must match', () => {
  const a = analyzeSpec(SPEC);
  const projects = [{ id: 'p', name: 'Shop', specs: [{ id: 's', title: 'Petstore' }], requests: [{ id: 'r1', name: 'My pets call', method: 'GET', url: '{{baseUrl}}/pets' }], folders: [{ name: 'Admin', requests: [{ id: 'r2', name: 'Reset', method: 'POST', url: '/admin/reset' }] }] }];
  const items = searchItems(projects, (id) => (id === 's' ? a : null));
  assert.equal(items.length, 5);
  const titles = (q) => searchApi(items, q).map((x) => x.title || x.path);
  assert.deepEqual(titles('pet').slice(0, 2).sort(), ['Find pet by ID', 'My pets call']);
  assert.deepEqual(titles('get pet id'), ['Find pet by ID']);
  assert.deepEqual(titles('getInventory'), ['Returns pet inventories']);
  assert.deepEqual(titles('vaccination'), ['Find pet by ID']); // description
  assert.match(searchApi(items, 'vaccination')[0].snippet, /vaccination records/);
  assert.deepEqual(titles('username'), ['Log in']); // parameter names
  assert.deepEqual(titles('admin'), ['Reset']); // folder
  assert.deepEqual(titles('pet zzz'), []);
  assert.deepEqual(titles('  '), []);
  assert.equal(searchApi(items, 'post')[0].title, 'Reset'); // exact method
});

test('git default terms: spec path + operationId, else literal URL path', () => {
  assert.deepEqual(defaultTerms({ op: { path: '/pets/{petId}', operationId: 'getPet' } }), ['/pets/{petId}', 'getPet']);
  assert.deepEqual(defaultTerms({ url: 'https://x/v1/orders/123/items', basePath: '/v1' }), ['/orders']);
  assert.deepEqual(defaultTerms({ url: 'https://x/api/users/me' }), ['/api/users/me']);
  assert.deepEqual(defaultTerms({ url: '{{baseUrl}}/a' }), []);
});

test('docs: field rows (nested, arrays, recursion), type labels, constraints', () => {
  const rows = fieldRows({ $ref: '#/components/schemas/Pet' }, SPEC);
  assert.deepEqual(rows.map((r) => [r.path, r.type, r.required]), [
    ['name', 'string', true], ['tags', 'array<string>', false], ['tags[]', 'string', false], ['parent', 'Pet (recursive)', false]]);
  assert.equal(rows[0].description, 'Pet **name**');
  assert.deepEqual(rows[0].constraints, ['e.g. "Rex"']);
  assert.deepEqual(rows[2].constraints, ['one of: "a", "b"']);
  assert.equal(typeLabel({ $ref: '#/components/schemas/Pet' }, SPEC), 'Pet');
  assert.equal(typeLabel({ type: ['string', 'null'], format: 'date' }, {}), 'string(date)?');
  assert.deepEqual(constraintsOf({ minimum: 1, maximum: 9, readOnly: true }), ['range 1–9', 'read-only']);
});

test('markdown: subset rendered, everything escaped', () => {
  assert.equal(markdown('Hello **world** and `code`\n\n- one\n- two'), '<p>Hello <b>world</b> and <code>code</code></p><ul><li>one</li><li>two</li></ul>');
  assert.equal(markdown('<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://e.com)'),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt; [x](javascript:alert(1)) <a href="https://e.com" target="_blank" rel="noopener">ok</a></p>');
  assert.equal(markdown('```\n<b>raw</b>\n```'), '<pre class="md-code">&lt;b&gt;raw&lt;/b&gt;</pre>');
});
