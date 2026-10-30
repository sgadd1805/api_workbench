// Bug report bundle: contents, redaction, Markdown and HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { electronAPI: { storageSet() {} } };
const { buildReport, toMarkdown, toHtml, redactUrl } = await import('../renderer/app/report.js');

const loc = { p: { name: 'Pets' }, r: { name: 'Get pet', method: 'GET', assertions: ['status === 200'] } };
const res = {
  status: 500, statusText: 'Internal Server Error', time: 87, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc' },
  body: '{"error":"boom <script>"}',
  requestData: { method: 'GET', url: 'https://api.test/pets/7?access_token=SECRET&x=1', headers: { Authorization: 'Bearer SECRET', Accept: 'application/json' }, body: '' },
  correlation: { requestId: 'req-1', traceId: 'trace-1' }, timing: { dns: 1, tcp: 2, tls: 3, request: 0.5, wait: 80, download: 0.5 },
  warnings: ['{{x}} is not defined'], assertionResults: [{ expr: 'status === 200', ok: false }], snapshotResult: { matches: false, diffs: [{ path: '$.error', expected: '"ok"', actual: '"boom"' }] },
};

test('redaction: auth headers, cookies, secret query params, URL passwords', () => {
  assert.equal(redactUrl('https://u:pw@a.test/x?token=1&page=2'), 'https://u:redacted@a.test/x?token=<redacted>&page=2');
  const md = toMarkdown(buildReport({ loc, res, envName: 'dev', logs: [] }));
  assert.ok(!md.includes('SECRET') && !md.includes('sid=abc'), md);
  assert.match(md, /Authorization: <redacted>/);
  const raw = toMarkdown(buildReport({ loc, res, redact: false }));
  assert.match(raw, /Bearer SECRET/);
});

test('markdown: title, meta, request, response, checks, timing, logs, cURL', () => {
  const md = toMarkdown(buildReport({ loc, res, envName: 'dev', logs: [{ name: 'pets-service', lines: [{ text: 'ERROR boom rid=req-1' }] }, { name: 'empty', lines: [] }] }));
  assert.match(md, /^## GET \/pets\/7 → 500 Internal Server Error/);
  assert.match(md, /\*\*Environment:\*\* dev/);
  assert.match(md, /\*\*X-Request-Id:\*\* req-1/);
  assert.match(md, /"error": "boom <script>"/); // pretty JSON body
  assert.match(md, /- ❌ assertion `status === 200`/);
  assert.match(md, /- ❌ 1 difference\(s\) from the snapshot/);
  assert.match(md, /- ⚠ \{\{x\}\} is not defined/);
  assert.match(md, /\| Waiting \(TTFB\) \| 80 ms \|/);
  assert.match(md, /### Server log: pets-service\n```\nERROR boom rid=req-1\n```/);
  assert.ok(!md.includes('Server log: empty'));
  assert.match(md, /### Reproduce\n```bash\ncurl/);
});

test('html: standalone page, escaped content, errors shown', () => {
  const html = toHtml(buildReport({ loc, res }));
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('boom &lt;script&gt;') && !html.includes('boom <script>'));
  const err = toHtml(buildReport({ loc, res: { error: 'ECONNREFUSED 127.0.0.1:8080', requestData: res.requestData } }));
  assert.match(err, /<h2>Error<\/h2>\s*<pre class="bad">ECONNREFUSED/);
});
