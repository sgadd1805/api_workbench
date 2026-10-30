// Command-line runner (bin/api-workbench.js): arguments, where projects come from, and real runs against a
// local server — passing and failing checks, exit codes, JUnit / JSON output, and secrets kept out of both.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

await import('../cli/node-api.mjs');
const { parseCli, UsageError } = await import('../cli/args.mjs');
const { defaultDataDir, resetDB, loadDataDir, loadConfigFile, findProject, useEnv, applyOverrides, resolveScope, requestsFor, readDataFile, SetupError } = await import('../cli/load.mjs');
const { knownSecrets } = await import('../cli/report.mjs');

const BIN = fileURLToPath(new URL('../bin/api-workbench.js', import.meta.url));
const TOKEN = 'tok-3f9a1c7e5b';          // what the server's /login hands out
const API_KEY = 'key-from-ci-9876abcd';   // a secret variable, supplied as AW_VAR_apiKey
const STORED = 'stored-bearer-42xyz';     // a literal bearer token saved in db.json

let server, base, dir;
const seen = []; // requests the server got: { method, url, headers }

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/login') return json(200, { token: TOKEN });
      if (u.pathname.startsWith('/status/')) return json(Number(u.pathname.slice(8)), {});
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${STORED}`) return json(401, { error: 'unauthorised' });
      if (req.headers['x-api-key'] && req.headers['x-api-key'] !== API_KEY) return json(403, { error: 'bad key' });
      if (u.pathname === '/pets') return json(200, [{ id: 1, name: 'Rex' }]);
      if (u.pathname === '/pets/1') return json(200, { id: 1, name: 'Rex' });
      if (u.pathname === '/pets/2') return json(200, { id: 'two', name: 'Fido' }); // breaks the spec: id is an integer
      if (u.pathname === '/echo') return json(200, { q: Object.fromEntries(u.searchParams) });
      json(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cli-'));
  writeConfig('api-client.json');
  writeDataDir(path.join(dir, 'data'));
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const SPEC = {
  openapi: '3.0.3', info: { title: 'Pets', version: '1' },
  paths: { '/pets/{id}': { get: { operationId: 'getPet', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, name: { type: 'string' } } } } } } } } } },
};

function writeConfig(name, edit = (c) => c) {
  fs.writeFileSync(path.join(dir, 'pets.json'), JSON.stringify(SPEC));
  const cfg = {
    version: 1,
    project: { name: 'Pet Store', auth: { type: 'bearer', token: '{{token}}' } },
    environments: [
      { name: 'local', active: true, variables: { baseUrl: 'http://127.0.0.1:9' } },
      { name: 'staging', variables: { baseUrl: base, apiKey: { secret: true } } },
    ],
    folders: [
      { name: 'Auth', auth: 'none', requests: [
        { name: 'Log in', method: 'POST', url: '{{baseUrl}}/login', json: { key: '{{apiKey}}' }, assertions: ['status === 200'], extract: { token: 'token' } }] },
      { name: 'Pets', requests: [
        { name: 'List pets', url: '{{baseUrl}}/pets', headers: { 'X-Api-Key': '{{apiKey}}' }, assertions: ['status === 200', 'Array.isArray(body)'] },
        { name: 'Get pet', url: '{{baseUrl}}/pets/1', operation: 'getPet',
          scripts: { post: "test('named Rex', () => expect(response.json().name).toBe('Rex')); log('key', vars.get('apiKey'));" } }] },
    ],
    specs: ['pets.json'],
  };
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(edit(cfg)));
  return file;
}

// An app data folder: db.json (with a literal token) and a stored spec, as the app would leave them.
function writeDataDir(data) {
  fs.mkdirSync(path.join(data, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(data, 'specs', 'spec1.json'), JSON.stringify(SPEC));
  const req = (id, name, url, extra = {}) => ({ id, name, method: 'GET', url, headers: [], assertions: [], ...extra });
  const db = {
    projects: [{
      id: 'p1', name: 'Shop', auth: { type: 'bearer', token: STORED }, activeEnv: 'e1',
      envs: [
        { id: 'e1', name: 'dev', vars: [{ k: 'baseUrl', v: 'http://127.0.0.1:9', on: true }] },
        { id: 'e2', name: 'Staging', vars: [{ k: 'baseUrl', v: base, on: true }, { k: 'apiKey', v: '', on: true, secret: true }, { k: 'id', v: '1', on: true }] },
      ],
      specs: [{ id: 'spec1', title: 'Pets', version: '1', source: { type: 'file', location: '/nowhere/pets.json' } }],
      folders: [{ id: 'f1', name: 'Pets', requests: [
        req('r1', 'Get pet by id', '{{baseUrl}}/pets/{{id}}', { headers: [{ k: 'X-Api-Key', v: '{{apiKey}}', on: true }], assertions: ['status === 200', 'body.id === 1'] }),
        req('r2', 'Get pet 2', '{{baseUrl}}/pets/2'),
      ] }],
      requests: [req('r3', 'Server error', '{{baseUrl}}/status/503')],
    }],
    features: [{ id: 'ft1', name: 'Checkout', requestIds: ['r2'] }],
  };
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({ db }));
}

// Runs the CLI in a child process. → { code, stdout, stderr }
function cli(args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AW_|GITHUB_ACTIONS$|FORCE_COLOR$)/.test(k)));
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd: dir, env: { ...clean, NO_COLOR: '1', ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('parseCli: commands, options, repeatable --var, network overrides, usage errors', () => {
  assert.deepEqual(parseCli([]), { command: 'help' });
  assert.deepEqual(parseCli(['--version']), { command: 'version' });
  const a = parseCli(['run', 'Pet Store', '--env', 'staging', '--junit', 'r.xml', '-n', '3', '--delay', '50', '--bail', '--var', 'a=1', '--var', 'b=x=y', '-k', '--http2', '-f', 'Pets']);
  assert.equal(a.command, 'run');
  assert.equal(a.project, 'Pet Store');
  assert.equal(a.env, 'staging');
  assert.equal(a.folder, 'Pets');
  assert.equal(a.junit, 'r.xml');
  assert.equal(a.iterations, 3);
  assert.equal(a.delayMs, 50);
  assert.equal(a.bail, true);
  assert.deepEqual(a.vars, [['a', '1'], ['b', 'x=y']]);
  assert.deepEqual(a.network, { insecure: true, http2: true });
  assert.deepEqual(parseCli(['run', '--config', 'c.json', '--pfx', 'id.p12', '--ca-file', 'ca.pem']).network, { pfxFile: 'id.p12', certFile: '', keyFile: '', caFile: 'ca.pem' });
  assert.equal(parseCli(['run', '--config', 'c.json']).project, null);
  for (const bad of [['run'], ['go'], ['run', 'P', '--nope'], ['run', 'P', '-n', '0'], ['run', 'P', '--delay', 'soon'], ['run', 'P', '--var', 'novalue'],
    ['run', 'P', '--folder', 'a', '--feature', 'b'], ['run', 'P', '--cert', 'c.pem'], ['run', 'Pet', 'Store']]) {
    assert.throws(() => parseCli(bad), UsageError, bad.join(' '));
  }
});

test('defaultDataDir: the app\'s user-data folder on each OS', () => {
  assert.equal(defaultDataDir('darwin', {}, '/Users/ann'), '/Users/ann/Library/Application Support/api-workbench');
  assert.equal(defaultDataDir('win32', { APPDATA: 'C:\\Users\\ann\\AppData\\Roaming' }, 'C:\\Users\\ann'), 'C:\\Users\\ann\\AppData\\Roaming\\api-workbench');
  assert.equal(defaultDataDir('linux', {}, '/home/ann'), '/home/ann/.config/api-workbench');
  assert.equal(defaultDataDir('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/ann'), '/cfg/api-workbench');
});

test('resolution from db.json: project, environment (ignoring case), folder / feature scope, overrides', () => {
  resetDB();
  assert.throws(() => loadDataDir(path.join(dir, 'missing')), SetupError);
  loadDataDir(path.join(dir, 'data'));
  const p = findProject('shop');
  assert.equal(p.name, 'Shop');
  assert.throws(() => findProject('Nope'), /No project "Nope". Available: "Shop"/);
  assert.throws(() => useEnv(p, 'prod'), /Available: "dev", "Staging"/);
  const env = useEnv(p, 'staging');
  assert.equal(p.activeEnv, 'e2');
  const { warnings } = applyOverrides(p, env, { processEnv: {} });
  assert.match(warnings[0], /Secret variable "apiKey" has no value .*AW_VAR_apiKey/);
  const o = applyOverrides(p, env, { vars: [['id', '2'], ['extra', 'yes']], network: { insecure: true, caFile: 'ca.pem' }, processEnv: { AW_VAR_apiKey: API_KEY, AW_VAR_id: '7', AW_PASSPHRASE: 'pass-phrase-1' }, cwd: '/work' });
  assert.deepEqual(o.warnings, []);
  const v = Object.fromEntries(env.vars.map((r) => [r.k, r.v]));
  assert.deepEqual([v.apiKey, v.id, v.extra], [API_KEY, '2', 'yes']); // --var beats AW_VAR_
  assert.equal(env.network.insecure, true);
  assert.equal(env.network.caFile, path.resolve('/work', 'ca.pem'));
  assert.equal(env.network.passphrase, 'pass-phrase-1');
  // Masked: the stored bearer token, the secret variable, the passphrase; not the plain base URL.
  const secrets = knownSecrets({ AW_PASSPHRASE: 'pass-phrase-1' });
  for (const s of [STORED, API_KEY, 'pass-phrase-1']) assert.ok(secrets.includes(s), s);
  assert.ok(!secrets.includes(base));
  assert.deepEqual(requestsFor(p, resolveScope(p).scope).map((l) => l.r.name), ['Server error', 'Get pet by id', 'Get pet 2']);
  assert.deepEqual(requestsFor(p, resolveScope(p, { folder: 'pets' }).scope).map((l) => l.r.name), ['Get pet by id', 'Get pet 2']);
  assert.deepEqual(requestsFor(p, resolveScope(p, { feature: 'Checkout' }).scope).map((l) => l.r.name), ['Get pet 2']);
  assert.throws(() => resolveScope(p, { folder: 'Orders' }), /No folder "Orders" in project "Shop". Available: "Pets"/);
  // A project without environments gets one for the overrides.
  const bare = { ...p, envs: [], activeEnv: null };
  assert.equal(applyOverrides(bare, null, { vars: [['a', '1']], processEnv: {} }).env.name, 'Default');
});

test('resolution from api-client.json: applied in memory, specs attached and operations linked', async () => {
  resetDB();
  const { project: p, warnings } = await loadConfigFile(path.join(dir, 'api-client.json'));
  assert.deepEqual(warnings, []);
  assert.equal(p.name, 'Pet Store');
  assert.equal(p.specs.length, 1);
  assert.equal(p.folders[1].requests[1].spec.opKey, 'GET /pets/{id}');
  assert.equal(useEnv(p, null).name, 'local'); // the file's active environment
  await assert.rejects(loadConfigFile(path.join(dir, 'nope.json')), /not found/);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ nope');
  await assert.rejects(loadConfigFile(path.join(dir, 'bad.json')), SetupError);
});

test('readDataFile: CSV and JSON rows', () => {
  fs.writeFileSync(path.join(dir, 'rows.csv'), 'id,name\n1,Rex\n2,Fido\n');
  fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify([{ id: 1 }, { id: 2, tags: ['a'] }]));
  assert.deepEqual(readDataFile(path.join(dir, 'rows.csv')), [{ id: '1', name: 'Rex' }, { id: '2', name: 'Fido' }]);
  assert.deepEqual(readDataFile(path.join(dir, 'rows.json')), [{ id: '1' }, { id: '2', tags: '["a"]' }]);
  fs.writeFileSync(path.join(dir, 'empty.csv'), 'id\n');
  assert.throws(() => readDataFile(path.join(dir, 'empty.csv')), /No data rows/);
});

test('run --config: all pass → exit 0, JUnit and JSON written, the secret never printed', async () => {
  seen.length = 0;
  const r = await cli(['run', 'Pet Store', '--config', 'api-client.json', '--env', 'staging', '--junit', 'out/results.xml', '--json', 'out/results.json', '--verbose'], { AW_VAR_apiKey: API_KEY });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Pet Store · environment staging/);
  assert.match(r.stdout, /PASS {2}POST {3}Log in/);
  assert.match(r.stdout, /PASS {2}GET {4}Get pet/);
  assert.match(r.stdout, /3 passed, 0 failed, 3 total/);
  assert.match(r.stdout, /log key \[REDACTED\]/); // script log, with the secret hidden
  // The key really went out, and the token from Log in was used by the requests after it.
  assert.equal(seen.find((s) => s.url === '/pets').headers['x-api-key'], API_KEY);
  assert.equal(seen.find((s) => s.url === '/pets/1').headers.authorization, `Bearer ${TOKEN}`);
  const xml = fs.readFileSync(path.join(dir, 'out/results.xml'), 'utf8');
  assert.match(xml, /<testsuite name="Pet Store" tests="3" failures="0">/);
  assert.match(xml, /<testcase classname="Pet Store" name="GET List pets"/);
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'out/results.json'), 'utf8'));
  assert.deepEqual(json.summary, { ...json.summary, total: 3, passed: 3, failed: 0 });
  assert.equal(json.environment, 'staging');
  for (const text of [r.stdout, r.stderr, xml, JSON.stringify(json)]) { assert.ok(!text.includes(API_KEY)); assert.ok(!text.includes(TOKEN)); }
});

test('run --config: failing assertions, script tests and HTTP status → exit 1, failures reported', async () => {
  const file = writeConfig('failing.json', (c) => {
    c.folders[1].requests[0].assertions = ['status === 201'];
    c.folders[1].requests[1].url = '{{baseUrl}}/pets/2'; // spec violation, and the script test fails
    c.folders[1].requests.push({ name: 'Gone', url: '{{baseUrl}}/status/410' });
    return c;
  });
  const r = await cli(['run', '--config', file, '--env', 'staging', '--junit', 'out/failing.xml'], { AW_VAR_apiKey: API_KEY });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL {2}GET {4}List pets/);
  assert.match(r.stdout, /× assertion failed: status === 201/);
  assert.match(r.stdout, /× test failed: named Rex — expected "?Rex"?, got "?Fido"?/);
  assert.match(r.stdout, /× spec: .*id/);
  assert.match(r.stdout, /× HTTP 410/);
  assert.match(r.stdout, /1 passed, 3 failed, 4 total/);
  const xml = fs.readFileSync(path.join(dir, 'out/failing.xml'), 'utf8');
  assert.match(xml, /tests="4" failures="3"/);
  assert.match(xml, /<failure message="assertion failed: status === 201">/);
  assert.ok(!r.stdout.includes(API_KEY));
});

test('run --data: project by name, environment, spec from the app\'s spec store, folder, feature, data rows, bail', async () => {
  const data = path.join(dir, 'data');
  const env = { AW_VAR_apiKey: API_KEY };
  let r = await cli(['run', 'Shop', '--data', data, '--env', 'staging', '--folder', 'Pets'], env);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS {2}GET {4}Get pet by id/);
  assert.match(r.stdout, /FAIL {2}GET {4}Get pet 2 .*200/);
  assert.match(r.stdout, /× spec: /); // id "two" isn't an integer
  assert.ok(!r.stdout.includes(STORED) && !r.stdout.includes(API_KEY));

  r = await cli(['run', 'Shop', '--data', data, '--env', 'staging', '--feature', 'Checkout', '--json', 'out/feature.json'], env);
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'out/feature.json'), 'utf8')).results.map((x) => x.name), ['Get pet 2']);

  // One pass per CSV row; the row's columns are variables.
  fs.writeFileSync(path.join(dir, 'ids.csv'), 'id\n1\n1\n');
  r = await cli(['run', 'Shop', '--data', data, '-e', 'Staging', '-f', 'Pets', '-d', 'ids.csv', '--junit', 'out/rows.xml'], env);
  assert.match(r.stdout, /Pass 2 of 2/);
  assert.match(fs.readFileSync(path.join(dir, 'out/rows.xml'), 'utf8'), /classname="Shop \/ Pets #2"/);

  // --bail: the first request fails (HTTP 503), nothing after it runs.
  r = await cli(['run', 'Shop', '--data', data, '--env', 'staging', '--bail'], env);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /FAIL {2}GET {4}Server error/);
  assert.match(r.stdout, /0 passed, 1 failed, 1 total/);

  // The default environment (dev) points at a closed port: a connection error is a failure.
  r = await cli(['run', 'Shop', '--data', data, '--folder', 'Pets'], env);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /ERR/);
});

test('exit code 2: usage and setup errors', async () => {
  const data = path.join(dir, 'data');
  for (const [args, message] of [
    [['run'], /Name the project to run/],
    [['run', 'Shop', '--data', data, '--frobnicate'], /Unknown option '--frobnicate'/],
    [['run', 'Nope', '--data', data], /No project "Nope"/],
    [['run', 'Shop', '--data', data, '--env', 'prod'], /No environment "prod" .*"dev", "Staging"/],
    [['run', 'Shop', '--data', path.join(dir, 'empty')], /No API Workbench data/],
    [['run', 'Shop', '--config', 'api-client.json'], /describes project "Pet Store", not "Shop"|No project "Shop"/],
    [['run', 'Shop', '--data', data, '--data-file', 'missing.csv'], /Data file .* not found/],
  ]) {
    const r = await cli(args);
    assert.equal(r.code, 2, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, message);
  }
  const r = await cli(['list', '--data', data]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Shop\n {2}environments: dev \(active\), Staging\n {2}folders: Pets\n {2}requests: 3/);
});

test('GitHub Actions: failures become ::error annotations, without secrets', async () => {
  const r = await cli(['run', 'Shop', '--data', path.join(dir, 'data'), '--env', 'staging', '--folder', 'Pets'], { AW_VAR_apiKey: API_KEY, GITHUB_ACTIONS: 'true' });
  assert.match(r.stdout, /^::error title=GET Get pet 2::spec: /m);
  assert.ok(!r.stdout.includes(API_KEY));
});

// A self-signed certificate for 127.0.0.1 (key from node:crypto, certificate from node-forge).
function selfSigned() {
  const forge = createRequire(import.meta.url)('node-forge');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const name = [{ name: 'commonName', value: '127.0.0.1' }];
  cert.setSubject(name); cert.setIssuer(name);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return { key: privateKey, cert: forge.pki.certificateToPem(cert) };
}

test('--insecure and --ca-file: TLS settings reach the transport', async () => {
  const tls = selfSigned();
  fs.writeFileSync(path.join(dir, 'ca.pem'), tls.cert);
  const secure = https.createServer(tls, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  await new Promise((r) => secure.listen(0, '127.0.0.1', r));
  try {
    const file = writeConfig('tls.json', () => ({ project: { name: 'TLS' }, requests: [{ name: 'Hello', url: `https://127.0.0.1:${secure.address().port}/`, assertions: ['body.ok'] }] }));
    let r = await cli(['run', '--config', file]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /SELF_SIGNED|certificate/i);
    r = await cli(['run', '--config', file, '--insecure']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    r = await cli(['run', '--config', file, '--ca-file', 'ca.pem']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  } finally { secure.close(); }
});

test('db.json with secrets the app encrypted: cleared with a clear warning, and --var / AW_VAR_ fill them', () => {
  resetDB();
  const sealedDir = path.join(dir, 'sealed-data');
  fs.mkdirSync(sealedDir, { recursive: true });
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'db.json'), 'utf8'));
  const secretVar = data.db.projects[0].envs.flatMap((e) => e.vars).find((v) => v.secret);
  secretVar.v = { $secret: 'b3BhcXVlIERQQVBJIGJsb2I=' };
  fs.writeFileSync(path.join(sealedDir, 'db.json'), JSON.stringify(data));
  const warnings = loadDataDir(sealedDir);
  assert.match(warnings[0], /^1 secret value\(s\) in db.json are encrypted by the app .*--var <name>=<value> or AW_VAR_<name>/);
  const p = findProject('Shop'), env = useEnv(p, 'staging');
  assert.equal(env.vars.find((v) => v.secret).v, '');
  assert.deepEqual(applyOverrides(p, env, { processEnv: { AW_VAR_apiKey: API_KEY } }).warnings, []);
});
