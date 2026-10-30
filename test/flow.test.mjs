// Captured calls → templatized requests and linked flows (renderer/app/flow.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { electronAPI: {} };
const { buildFlow, templatize, originVars, useIn } = await import('../renderer/app/flow.js');

const H = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
const call = (method, url, { headers = {}, body = '', res, resHeaders = {} } = {}) => ({
  summary: { method, url, headers: H({ 'Content-Type': 'application/json', 'User-Agent': 'Chrome/130', 'sec-ch-ua': '"Chromium"', Cookie: 'sid=1', Referer: 'https://shop.test/', ...headers }), postData: body, mimeType: body ? 'application/json' : '' },
  detail: { response: { body: res === undefined ? '' : JSON.stringify(res), headers: resHeaders } },
});
const shop = () => [
  call('POST', 'https://auth.shop.test/oauth/token', { body: '{"user":"bo","password":"pw"}', res: { access_token: 'eyJabc.def.ghi', expires_in: 3600 } }),
  call('GET', 'https://api.shop.test/v1/me', { headers: { Authorization: 'Bearer eyJabc.def.ghi' }, res: { id: 'usr_8812', name: 'Bo Smith' }, resHeaders: { 'x-csrf-token': 'csrf-777abc' } }),
  call('POST', 'https://api.shop.test/v1/orders', { headers: { Authorization: 'Bearer eyJabc.def.ghi', 'X-CSRF-Token': 'csrf-777abc' }, body: '{"userId":"usr_8812","sku":"ABC-1","qty":2}', res: { order: { id: 40123, status: 'OPEN' } } }),
  call('GET', 'https://api.shop.test/v1/orders/40123?expand=items&user=usr_8812', { headers: { Authorization: 'Bearer eyJabc.def.ghi' }, res: { id: 40123 } }),
  call('POST', 'https://api.shop.test/v1/orders/40123/pay', { headers: { Authorization: 'Bearer OTHER-literal-token' }, body: '{"orderId":40123,"amount":12.5,"note":"Bo Smith"}' }),
];

test('a login → order flow: tokens, ids and CSRF values linked with extract rules', () => {
  const { requests: r, links, newVars, secretVars } = buildFlow(shop());
  assert.deepEqual(links, [
    { name: 'accessToken', from: 0, path: 'access_token', usedBy: [1, 2, 3] },
    { name: 'meId', from: 1, path: 'id', usedBy: [2, 3] },
    { name: 'csrfToken', from: 1, path: 'header.x-csrf-token', usedBy: [2] },
    { name: 'orderId', from: 2, path: 'order.id', usedBy: [3, 4] },
    { name: 'name', from: 1, path: 'name', usedBy: [4] }]);
  assert.deepEqual(r.map((x) => x.chain), [
    [{ k: 'access_token', v: 'accessToken', on: true }],
    [{ k: 'id', v: 'meId', on: true }, { k: 'header.x-csrf-token', v: 'csrfToken', on: true }, { k: 'name', v: 'name', on: true }],
    [{ k: 'order.id', v: 'orderId', on: true }], [], []]);
  assert.deepEqual(r.map((x) => x.url), ['{{baseUrl}}/oauth/token', '{{apiUrl}}/v1/me', '{{apiUrl}}/v1/orders',
    '{{apiUrl}}/v1/orders/{{orderId}}?expand=items&user={{meId}}', '{{apiUrl}}/v1/orders/{{orderId}}/pay']);
  assert.deepEqual(r.map((x) => x.auth), [{ type: 'inherit' }, ...Array(3).fill({ type: 'bearer', token: '{{accessToken}}' }), { type: 'bearer', token: '{{token}}' }]);
  assert.deepEqual(r[2].headers, [{ k: 'Content-Type', v: 'application/json', on: true }, { k: 'X-CSRF-Token', v: '{{csrfToken}}', on: true }]);
  assert.equal(r[2].body.text, '{\n  "userId": "{{meId}}",\n  "sku": "ABC-1",\n  "qty": 2\n}');
  assert.equal(r[4].body.text, '{\n  "orderId": {{orderId}},\n  "amount": 12.5,\n  "note": "{{name}}"\n}', 'numbers stay unquoted');
  assert.deepEqual(newVars, { baseUrl: 'https://auth.shop.test', apiUrl: 'https://api.shop.test', accessToken: 'eyJabc.def.ghi', meId: 'usr_8812', csrfToken: 'csrf-777abc', orderId: '40123', name: 'Bo Smith' });
  assert.deepEqual(secretVars, { token: 'OTHER-literal-token' });
  for (const x of r) assert.ok(!x.headers.some((h) => /^(user-agent|sec-ch-ua|cookie|referer|authorization)$/i.test(h.k)), 'browser and auth headers are not copied');
});

test('short or common values are not linked', () => {
  const { links, requests } = buildFlow([
    call('GET', 'https://x.test/api/items', { res: { page: 1, count: 12, kind: 'item', enabled: true, total: 99 } }),
    call('GET', 'https://x.test/api/items?page=1&count=12&kind=item&enabled=true&max=99'),
  ]);
  assert.deepEqual(links, []);
  assert.equal(requests[1].url, '{{baseUrl}}/api/items?page=1&count=12&kind=item&enabled=true&max=99');
});

test('origins reuse the environment\'s variables, including ones with a path', () => {
  assert.deepEqual([...originVars(['https://api.shop.test/v1/me', 'http://localhost:8080/x'], { baseUrl: 'https://api.shop.test/v1/' }).names],
    [['https://api.shop.test', { name: 'baseUrl', prefix: 'https://api.shop.test/v1' }], ['http://localhost:8080', { name: 'localUrl', prefix: 'http://localhost:8080' }]]);
  assert.equal(originVars(['https://api.shop.test/v10/x'], { baseUrl: 'https://api.shop.test/v1' }).names.get('https://api.shop.test').name, 'apiUrl', '/v1 is not a prefix of /v10');
  const { req, newVars, secretVars } = templatize(shop()[1].summary, { vars: { baseUrl: 'https://api.shop.test/v1' } });
  assert.deepEqual([req.url, req.auth, newVars, secretVars], ['{{baseUrl}}/me', { type: 'bearer', token: '{{token}}' }, {}, { token: 'eyJabc.def.ghi' }]);
});

test('a project that already sends auth keeps it: captured tokens are dropped', () => {
  const t = templatize(shop()[1].summary, { projectAuth: { type: 'bearer', token: '{{token}}' } });
  assert.deepEqual([t.req.auth, t.secretVars], [{ type: 'inherit' }, {}]);
  const f = buildFlow(shop(), { projectAuth: { type: 'token', sourceId: 's1' } });
  assert.deepEqual(f.requests[4].auth, { type: 'inherit' });
  assert.deepEqual(f.requests[1].auth, { type: 'bearer', token: '{{accessToken}}' }, 'a token the flow itself logs in for is still linked');
  assert.deepEqual(f.secretVars, {});
});

test('useIn replaces whole URL parts, headers, form fields and long raw text only', () => {
  const req = { url: '{{baseUrl}}/a/abc123/b?x=abc123&y=abc1234#h', headers: [{ k: 'X', v: 'id abc123' }], body: { type: 'form', text: '', form: [{ k: 'f', v: 'abc123' }, { k: 'g', v: 'abc1234' }] } };
  assert.equal(useIn(req, 'abc123', '{{v}}'), true);
  assert.deepEqual([req.url, req.headers[0].v, req.body.form.map((f) => f.v)], ['{{baseUrl}}/a/{{v}}/b?x={{v}}&y=abc1234#h', 'id {{v}}', ['{{v}}', 'abc1234']]);
  const raw = { url: 'https://x.test/', headers: [], body: { type: 'raw', text: 'token=abcd1234efgh&short=ab12' } };
  useIn(raw, 'abcd1234efgh', '{{t}}'); useIn(raw, 'ab12', '{{s}}');
  assert.equal(raw.body.text, 'token={{t}}&short=ab12');
  assert.equal(useIn({ url: 'https://x.test/', headers: [], body: { type: 'none' } }, 'nothere', '{{n}}'), false);
});

test('capturing a flow again reuses its variable names; secrets and URL variables are never reused', () => {
  const vars = { baseUrl: 'https://auth.shop.test', apiUrl: 'https://api.shop.test', accessToken: 'old', meId: 'old', orderId: '1', token: 'mine' };
  const again = buildFlow(shop(), { vars, secretNames: ['token'] });
  assert.deepEqual(again.links.map((l) => l.name), ['accessToken', 'meId', 'csrfToken', 'orderId', 'name']);
  assert.deepEqual(Object.keys(again.newVars), ['accessToken', 'meId', 'csrfToken', 'orderId', 'name']);
  assert.deepEqual(again.secretVars, { token2: 'OTHER-literal-token' }, 'the user\'s own secret {{token}} is left alone');
  const clash = buildFlow(shop(), { vars: { accessToken: 'https://not-a-token.test' } });
  assert.equal(clash.links[0].name, 'accessToken2');
});

test('checks from captured responses: status, shape, stable fields exact, changing ones by type', async () => {
  const { checksFor } = await import('../renderer/app/flow.js');
  assert.deepEqual(checksFor({ status: 201, body: JSON.stringify({ order: { id: 40123, status: 'OPEN', total: 12.5, createdAt: '2026-01-01T00:00:00Z', paid: false, ref: 'ORD-123456', items: [{ sku: 'ABC-1' }] }, access_token: 'eyJabc', note: null }) }), [
    'status === 201', "body.order && typeof body.order === 'object'", "typeof body.order.id === 'number'", 'body.order.status === "OPEN"',
    "typeof body.order.total === 'number'", "typeof body.order.createdAt === 'string'", 'body.order.paid === false', "typeof body.order.ref === 'string'",
    'Array.isArray(body.order.items)', 'body.order.items.length > 0', "typeof body.access_token === 'string'", 'body.note === null']);
  assert.deepEqual(checksFor({ status: 200, body: '[{"user-name":"Bo"}]' }), ['status === 200', 'Array.isArray(body)', 'body.length > 0', "body[0] && typeof body[0] === 'object'", 'body[0]["user-name"] === "Bo"']);
  assert.deepEqual(checksFor({ status: 204, body: '' }), ['status === 204']);
  assert.equal(checksFor({ status: 200, body: JSON.stringify(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]))) }).length, 9, 'at most 8 fields per object');
  const flow = buildFlow(shop(), { checks: true });
  assert.deepEqual(flow.requests[0].assertions, ["typeof body.access_token === 'string'", "typeof body.expires_in === 'number'"], 'no status in these captures, so none is checked');
  assert.deepEqual(buildFlow(shop()).requests[0].assertions, []);
});
