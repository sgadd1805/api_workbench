// File bodies: multipart/form-data with file parts and a file as the whole body — building (renderer),
// sending (main/http.js), cURL / code export, spec checks, and paths in api-client.json and repo files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import schema from '../docs/api-client.schema.json' with { type: 'json' };

globalThis.window = { electronAPI: { storageSet() {}, historyAppend() {} } };
const require = createRequire(import.meta.url);
const mainHttp = require('../main/http.js');
const { DB, newReq, addProject, addRequest, findReq, normalizeDB } = await import('../renderer/app/store.js');
const { buildRequest } = await import('../renderer/app/http.js');
const { toCurl, parseCurl } = await import('../renderer/app/curl.js');
const { applyConfig, exportConfig } = await import('../renderer/app/config.js');
const { toRepo, fromRepo } = await import('../renderer/app/repo.js');
const { validateSchema } = await import('../renderer/app/openapi/schema.js');
const { analyzeSpec } = await import('../renderer/app/openapi/spec.js');
const { validateRequest } = await import('../renderer/app/openapi/validate.js');
const { bodyFor } = await import('../renderer/app/openapi/generate.js');
const { mimeFor } = await import('../renderer/shared/mime.js');
const { entryFromSend } = await import('../renderer/app/history.js');

const fresh = () => { Object.assign(DB, { projects: [], features: [], notes: [], tokenSources: [], settings: { sidebarWidth: 240, openTabs: [], activeTab: null } }); normalizeDB(DB); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-bodies-'));
const png = path.join(tmp, 'pic.png');
fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
const txt = path.join(tmp, 'notes.txt');
fs.writeFileSync(txt, 'hello file');

// A server that hands back exactly what it got.
async function echoServer(t) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ headers: req.headers, body: Buffer.concat(chunks).toString('base64') }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('mime types from extensions', () => {
  assert.equal(mimeFor('/x/a.PNG'), 'image/png');
  assert.equal(mimeFor('C:\\x\\report.pdf'), 'application/pdf');
  assert.equal(mimeFor('/x/noext'), 'application/octet-stream');
});

test('buildRequest: multipart parts and a binary body, with relative paths in the code folder', () => {
  fresh();
  const p = addProject('P'); p.codeFolder = tmp;
  p.envs.push({ id: 'e', name: 'e', vars: [{ k: 'who', v: 'ann', on: true }], loginUrls: [], network: {} }); p.activeEnv = 'e';
  const r = addRequest(p, null, newReq({ method: 'POST', url: 'http://x/up', body: { type: 'multipart', text: '', form: [
    { k: 'name', v: '{{who}}', on: true },
    { k: 'pic', v: 'pic.png', on: true, file: true },
    { k: 'doc', v: txt, on: true, file: true, type: 'text/x-custom' },
    { k: 'off', v: 'x', on: false },
  ] } }));
  const w = buildRequest(findReq(r.id));
  assert.equal(w.body, '');
  assert.equal(w.headers['Content-Type'], 'multipart/form-data');
  assert.deepEqual(w.bodyParts, [
    { name: 'name', value: 'ann' },
    { name: 'pic', file: png, filename: 'pic.png', contentType: 'image/png' },
    { name: 'doc', file: txt, filename: 'notes.txt', contentType: 'text/x-custom' },
  ]);
  r.body = { type: 'binary', text: '', form: [], file: png };
  const b = buildRequest(findReq(r.id));
  assert.equal(b.bodyFile, png);
  assert.equal(b.headers['Content-Type'], 'image/png');
  r.headers = [{ k: 'content-type', v: 'application/octet-stream', on: true }];
  assert.equal(buildRequest(findReq(r.id)).headers['content-type'], 'application/octet-stream');
  // GET sends no body; a form body ignores rows marked as files.
  r.method = 'GET'; assert.equal(buildRequest(findReq(r.id)).bodyFile, undefined);
  r.method = 'POST'; r.headers = []; r.body = { type: 'form', text: '', form: [{ k: 'a', v: '1', on: true }, { k: 'f', v: png, on: true, file: true }] };
  assert.equal(buildRequest(findReq(r.id)).body, 'a=1');
});

test('main: multipart bytes on the wire, boundary in Content-Type, files read as they are', async (t) => {
  const base = await echoServer(t);
  const res = await mainHttp.proxyFetch({ url: base + '/up', method: 'POST', headers: { 'Content-Type': 'multipart/form-data' },
    bodyParts: [{ name: 'title', value: 'Hi "there"' }, { name: 'pic', file: png, filename: 'pic.png', contentType: 'image/png' }] });
  assert.equal(res.ok, true, res.error);
  const got = JSON.parse(res.body);
  const boundary = /boundary=(.+)$/.exec(got.headers['content-type'])[1];
  assert.match(got.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.equal(res.sentHeaders['Content-Type'], got.headers['content-type']);
  const raw = Buffer.from(got.body, 'base64');
  const expected = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHi "there"\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pic"; filename="pic.png"\r\nContent-Type: image/png\r\n\r\n`),
    fs.readFileSync(png), Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  assert.deepEqual(raw, expected);
  assert.equal(got.headers['content-length'], String(expected.length));
});

test('main: a boundary the request sets is kept; names are escaped', async () => {
  const { payload, headers } = await mainHttp.buildPayload({ headers: { 'content-type': 'multipart/form-data; boundary=XYZ' }, bodyParts: [{ name: 'a"b\r\nc', value: 'v' }] });
  assert.equal(headers['content-type'], 'multipart/form-data; boundary=XYZ');
  assert.match(payload.toString(), /^--XYZ\r\nContent-Disposition: form-data; name="a%22b%0D%0Ac"\r\n\r\nv\r\n--XYZ--\r\n$/);
  const mixed = await mainHttp.buildPayload({ headers: { 'Content-Type': 'multipart/mixed' }, bodyParts: [{ name: 'a', value: '1' }] });
  assert.match(mixed.headers['Content-Type'], /^multipart\/mixed; boundary=----api-workbench-[0-9a-f]{24}$/);
});

test('main: a binary body, and unreadable files fail the send with the path', async (t) => {
  const base = await echoServer(t);
  const res = await mainHttp.proxyFetch({ url: base, method: 'PUT', headers: { 'Content-Type': 'image/png' }, bodyFile: png });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(Buffer.from(JSON.parse(res.body).body, 'base64'), fs.readFileSync(png));
  const missing = await mainHttp.proxyFetch({ url: base, method: 'PUT', headers: {}, bodyFile: path.join(tmp, 'nope.bin') });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Body file: can't read .*nope\.bin \(ENOENT\)/);
  const dir = await mainHttp.proxyFetch({ url: base, method: 'POST', headers: {}, bodyParts: [{ name: 'f', file: tmp }] });
  assert.match(dir.error, /File for part "f": can't read/);
  const none = await mainHttp.proxyFetch({ url: base, method: 'POST', headers: {}, bodyParts: [{ name: 'f', file: '' }] });
  assert.match(none.error, /no file chosen/);
});

test('cURL: -F / --form-string / --data-binary @file out, and back in', () => {
  const wire = { method: 'POST', url: 'http://x/up', headers: { 'Content-Type': 'multipart/form-data', 'X-A': '1' }, body: '',
    bodyParts: [{ name: 'note', value: '@not-a-file' }, { name: 'pic', file: png, contentType: 'image/png' }] };
  const curl = toCurl(wire);
  assert.ok(!/Content-Type/.test(curl), 'curl makes its own multipart Content-Type');
  assert.match(curl, /--form-string 'note=@not-a-file'/);
  assert.match(curl, new RegExp(`-F 'pic=@${png.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};type=image/png'`));
  const back = parseCurl(curl);
  assert.equal(back.body.type, 'multipart');
  assert.deepEqual(back.body.form, [{ k: 'note', v: '@not-a-file', on: true }, { k: 'pic', v: png, on: true, file: true, type: 'image/png' }]);
  assert.deepEqual(back.headers, [{ k: 'X-A', v: '1', on: true }]);
  const bin = parseCurl(toCurl({ method: 'PUT', url: 'http://x', headers: {}, body: '', bodyFile: '/tmp/a b.bin' }));
  assert.deepEqual([bin.method, bin.body.type, bin.body.file], ['PUT', 'binary', '/tmp/a b.bin']);
  assert.deepEqual(parseCurl('curl -T ./x.zip https://h/u').body, { type: 'binary', text: '', form: [], file: './x.zip' });
  assert.equal(parseCurl("curl https://h -F 'a=1' -H 'Content-Type: multipart/form-data; boundary=zz'").headers.length, 0);
});

test('spec check: multipart fields typed and required; file bodies count as a body', () => {
  const analysis = analyzeSpec({ openapi: '3.0.0', paths: { '/up': { post: { requestBody: { required: true, content: { 'multipart/form-data': { schema: {
    type: 'object', required: ['title', 'pic'], properties: { title: { type: 'string' }, count: { type: 'integer' }, pic: { type: 'string', format: 'binary' } } } } } }, responses: { 200: {} } } } } });
  const op = analysis.operations[0];
  const issues = (w) => validateRequest(analysis, op, { method: 'POST', url: '/up', headers: { 'Content-Type': 'multipart/form-data' }, body: '', ...w }, {});
  assert.deepEqual(issues({ bodyParts: [{ name: 'title', value: 'x' }, { name: 'count', value: '3' }, { name: 'pic', file: '/a.png', filename: 'a.png' }] }), []);
  assert.deepEqual(issues({ bodyParts: [{ name: 'count', value: 'three' }] }).map((i) => i.where).sort(), ['body.count', 'body.pic', 'body.title']);
  assert.deepEqual(issues({}).map((i) => i.message), ['is required']);
  // Generated request: file properties become file parts.
  const { body } = bodyFor(op, analysis.doc);
  assert.equal(body.type, 'multipart');
  assert.deepEqual(body.form.map((x) => [x.k, !!x.file]), [['title', false], ['count', false], ['pic', true]]);
  const upload = analyzeSpec({ openapi: '3.0.0', paths: { '/f': { put: { requestBody: { content: { 'image/png': {} } }, responses: {} } } } }).operations[0];
  assert.deepEqual(bodyFor(upload, {}), { body: { type: 'binary', text: '', form: [], file: '' }, contentType: 'image/png' });
});

test('History keeps the parts and the file of a send', () => {
  const e = entryFromSend({ r: { id: 'r', name: 'n', method: 'POST', url: 'u' }, p: { id: 'p' } },
    { status: 200, body: '', requestData: { method: 'POST', url: 'u', headers: {}, body: '', bodyParts: [{ name: 'a', value: '1' }], bodyFile: '' } });
  assert.deepEqual(e.request, { headers: {}, body: '', parts: [{ name: 'a', value: '1' }] });
});

test('api-client.json: file paths stay inside the code folder; export writes them relative', () => {
  fresh();
  const cfg = { project: { name: 'Files' }, requests: [
    { name: 'Upload', method: 'POST', url: 'http://x/up', body: { type: 'multipart', fields: { title: 'Hi', pic: { file: 'fixtures/pic.png', type: 'image/png' }, key: { file: '../../.ssh/id_rsa' }, abs: { file: '/etc/passwd' } } } },
    { name: 'Raw', method: 'PUT', url: 'http://x/raw', body: { type: 'binary', file: 'fixtures/a.bin' } },
    { name: 'Many', method: 'POST', url: 'http://x/m', body: { type: 'multipart', fields: [{ name: 'files', file: 'a.png' }, { name: 'files', file: 'b.png' }, { name: 'note', value: 'x', enabled: false }] } },
  ] };
  assert.deepEqual(validateSchema(schema, cfg, { root: schema }), []);
  const { project: p, warnings } = applyConfig(cfg, { codeFolder: '/code' });
  const up = p.requests.find((r) => r.name === 'Upload');
  assert.deepEqual(up.body.form, [
    { k: 'title', v: 'Hi', on: true }, { k: 'pic', v: '/code/fixtures/pic.png', on: true, file: true, type: 'image/png' },
    { k: 'key', v: '', on: true, file: true }, { k: 'abs', v: '', on: true, file: true },
  ]);
  assert.equal(warnings.filter((w) => /must be inside the code folder/.test(w)).length, 2);
  assert.equal(p.requests.find((r) => r.name === 'Raw').body.file, '/code/fixtures/a.bin');
  assert.deepEqual(p.requests.find((r) => r.name === 'Many').body.form.map((x) => [x.k, x.v, x.on]), [['files', '/code/a.png', true], ['files', '/code/b.png', true], ['note', 'x', false]]);
  // The user's own absolute path survives re-applying their own export.
  up.body.form[3].v = '/Users/me/Desktop/x.png';
  const out = exportConfig(p);
  const upOut = out.config.requests.find((r) => r.name === 'Upload');
  assert.deepEqual(upOut.body.fields.pic, { file: 'fixtures/pic.png', type: 'image/png' });
  assert.deepEqual(upOut.body.fields.abs, { file: '/Users/me/Desktop/x.png' });
  assert.ok(out.warnings.some((w) => /outside the code folder/.test(w)));
  assert.deepEqual(out.config.requests.find((r) => r.name === 'Raw').body, { type: 'binary', file: 'fixtures/a.bin' });
  assert.ok(Array.isArray(out.config.requests.find((r) => r.name === 'Many').body.fields), 'repeated names export as a list');
  assert.deepEqual(validateSchema(schema, out.config, { root: schema }), []);
  const again = applyConfig(out.config, { project: p, codeFolder: '/code' });
  assert.equal(p.requests.find((r) => r.name === 'Upload').body.form[3].v, '/Users/me/Desktop/x.png');
  assert.ok(!again.warnings.some((w) => /must be inside/.test(w)));
});

test('repo files: body paths relative; paths outside the code folder only kept when already local', () => {
  fresh();
  const p = addProject('R'); p.codeFolder = '/code';
  const r = addRequest(p, null, newReq({ name: 'Up', method: 'POST', body: { type: 'multipart', text: '', form: [{ k: 'f', v: '/code/fx/a.png', on: true, file: true }, { k: 'g', v: '/elsewhere/b.png', on: true, file: true }] } }));
  const { files, project } = toRepo(p);
  assert.deepEqual(files[0].data.body.form.map((x) => x.v), ['fx/a.png', '/elsewhere/b.png']);
  assert.equal(r.body.form[0].v, '/code/fx/a.png', 'the stored request is unchanged');
  // Loading the same files back keeps both; a pulled change to a path outside is dropped.
  const data = structuredClone(files[0].data);
  let stats = fromRepo(p, { project, requests: [{ data }] });
  assert.deepEqual(r.body.form.map((x) => x.v), ['/code/fx/a.png', '/elsewhere/b.png']);
  assert.ok(!stats.filesDropped);
  data.body.form[1].v = '/Users/me/.ssh/id_rsa'; data.body.form[0].v = '../outside.png';
  stats = fromRepo(p, { project, requests: [{ data }] });
  assert.deepEqual(findReq(r.id).r.body.form.map((x) => x.v), ['', '']);
  assert.equal(stats.filesDropped, 2);
});
