// Token sources: file import shapes, building the token request, extracting/caching tokens, auth + 401 retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
let responder = () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: '{}' });
globalThis.window = { electronAPI: { storageSet() {}, historyAppend() {}, doFetch: async (req) => { calls.push(req); return responder(req); } } };

const { DB, S, newReq, addProject, addRequest, addEnv } = await import('../renderer/app/store.js');
const { tokenSourceFromFile, buildSourceRequest, extractToken, getToken, cachedToken, forgetTokens, jwtExpiry, newTokenSource } = await import('../renderer/app/tokens.js');
const { send, buildRequest } = await import('../renderer/app/http.js');

const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

test('import: the bare request object (as documented for the token-source picker)', () => {
  const t = tokenSourceFromFile(JSON.stringify({
    method: 'POST', url: 'https://example.com/oauth/token',
    headers: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true }],
    body: 'grant_type=client_credentials&client_id={{clientId}}&client_secret={{clientSecret}}', body_type: 'raw',
  }));
  assert.equal(t.method, 'POST');
  assert.equal(t.url, 'https://example.com/oauth/token');
  assert.deepEqual(t.headers, [{ k: 'Content-Type', v: 'application/x-www-form-urlencoded', on: true }]);
  assert.deepEqual([t.body.type, t.body.text], ['raw', 'grant_type=client_credentials&client_id={{clientId}}&client_secret={{clientSecret}}']);
  assert.equal(t.tokenPath, 'access_token');
  assert.ok(t.id && t.name.includes('oauth/token'));
});

test('import: token_path, disabled headers, full exports pick the first request', () => {
  const entry = tokenSourceFromFile(JSON.stringify({ id: 'ts_abc123', name: 'OAuth2 client credentials', method: 'post', url: 'https://x/t', headers: [{ key: 'X', value: '1', enabled: false }], body: 'a=1', body_type: 'raw', token_path: 'data.token' }));
  assert.deepEqual([entry.name, entry.method, entry.tokenPath, entry.headers[0].on], ['OAuth2 client credentials', 'POST', 'data.token', false]);
  assert.notEqual(entry.id, 'ts_abc123'); // always a fresh id
  const nativeExport = { format: 'thick-client-collection', project: { name: 'P', envs: [{ vars: [{ k: 'a', v: 'b' }] }], folders: [], requests: [{ name: 'Login', method: 'POST', url: '{{base}}/token', headers: [{ k: 'A', v: '1', on: true }], body: { type: 'json', text: '{"u":1}' } }] } };
  const fromExport = tokenSourceFromFile(JSON.stringify(nativeExport));
  assert.deepEqual([fromExport.name, fromExport.url, fromExport.body.type, fromExport.headers[0].k], ['Login', '{{base}}/token', 'json', 'A']);
  assert.equal(tokenSourceFromFile(JSON.stringify({ db: { projects: [{ requests: [{ method: 'GET', url: 'u' }] }] } })).url, 'u');
  assert.throws(() => tokenSourceFromFile('{"nothing":true}'), /No request/);
  assert.throws(() => tokenSourceFromFile('nope'), /Not a JSON/);
});

test('token request uses the project\'s active environment; extraction handles expiry', () => {
  DB.projects = []; DB.tokenSources = [];
  const p = addProject('P'), env = addEnv(p, 'dev');
  env.vars.push({ k: 'clientId', v: 'abc', on: true }, { k: 'base', v: 'https://auth.test', on: true });
  const src = newTokenSource({ url: '{{base}}/oauth/token', body: { type: 'form', text: '', form: [{ k: 'client_id', v: '{{clientId}}', on: true }, { k: 'scope', v: 'a b', on: true }] } });
  assert.deepEqual(buildSourceRequest(src, p), { method: 'POST', url: 'https://auth.test/oauth/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'client_id=abc&scope=a%20b', network: env.network ?? null });
  const now = 1_000_000;
  assert.deepEqual(extractToken(src, { status: 200, body: '{"access_token":"t1","expires_in":60}' }, now), { token: 't1', expiresAt: now + 60_000 });
  const exp = Math.floor(now / 1000) + 3600;
  assert.equal(extractToken(src, { status: 200, body: JSON.stringify({ access_token: jwt({ exp }) }) }, now).expiresAt, exp * 1000);
  assert.equal(extractToken({ ...src, tokenPath: 'data.token' }, { status: 200, body: '{"data":{"token":"t2"}}' }).token, 't2');
  assert.throws(() => extractToken(src, { status: 200, body: '{"nope":1}' }), /No "access_token"/);
  assert.throws(() => extractToken(src, { status: 500, body: '<html>' }), /did not return JSON/);
  assert.equal(jwtExpiry('not.a.jwt'), null);
});

test('getToken caches per project environment and refreshes when expired', async () => {
  DB.projects = []; DB.tokenSources = [];
  const p = addProject('P'); const dev = addEnv(p, 'dev'); const prod = addEnv(p, 'prod');
  const src = newTokenSource({ url: 'https://auth.test/token' }); DB.tokenSources.push(src);
  let n = 0; calls.length = 0;
  responder = () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: JSON.stringify({ access_token: 'tok' + (++n), expires_in: 3600 }) });
  p.activeEnv = dev.id;
  assert.equal((await getToken(src.id, p)).token, 'tok1');
  assert.equal((await getToken(src.id, p)).token, 'tok1'); // cached
  p.activeEnv = prod.id;
  assert.equal((await getToken(src.id, p)).token, 'tok2'); // other environment, other token
  assert.equal((await getToken(src.id, p, { force: true })).token, 'tok3');
  assert.equal(cachedToken(src.id, p, Date.now() + 3600_000), null); // past expiry (minus margin)
  forgetTokens(src.id);
  assert.equal(cachedToken(src.id, p), null);
  responder = () => ({ ok: true, status: 401, statusText: 'Unauthorized', headers: {}, body: 'bad client' });
  await assert.rejects(getToken(src.id, p), /failed: HTTP 401 Unauthorized — bad client/);
  await assert.rejects(getToken('missing', p), /no longer exists/);
});

test('send with token-source auth: Bearer header, 401 → refetch + retry once', async () => {
  DB.projects = []; DB.tokenSources = []; S.tabs = []; S.req = null;
  const p = addProject('P');
  const src = newTokenSource({ name: 'Auth', url: 'https://auth.test/token' }); DB.tokenSources.push(src);
  p.auth = { type: 'token', sourceId: src.id };
  const r = addRequest(p, null, newReq({ url: 'https://api.test/me' }));
  const loc = { p, f: null, r };
  let issued = 0, apiCalls = 0;
  responder = (req) => {
    if (req.url === 'https://auth.test/token') return { ok: true, status: 200, statusText: 'OK', headers: {}, body: JSON.stringify({ access_token: 'T' + (++issued) }) };
    apiCalls++;
    const ok = req.headers.Authorization === 'Bearer T2';
    return { ok: true, status: ok ? 200 : 401, statusText: ok ? 'OK' : 'Unauthorized', headers: {}, body: '{}' };
  };
  forgetTokens();
  const res = await send(loc);
  assert.equal(res.status, 200);
  assert.equal(res.requestData.headers.Authorization, 'Bearer T2');
  assert.deepEqual([issued, apiCalls], [2, 2]);
  assert.match(res.warnings.join(), /fresh token was fetched/);
  assert.equal(buildRequest(loc).headers.Authorization, 'Bearer T2'); // cURL export uses the cached token
  forgetTokens();
  assert.equal(buildRequest(loc).headers.Authorization, 'Bearer <token from Auth>');
  responder = () => ({ ok: true, status: 500, statusText: 'x', headers: {}, body: 'down' });
  assert.match((await send(loc)).error, /Token source "Auth" failed: HTTP 500/);
});

test('token inspector: bearer detection, JWT payload, expiry', async () => {
  const { bearerOf, inspectToken, jwtPayload } = await import('../renderer/app/tokens.js');
  assert.equal(bearerOf({ authorization: 'Bearer abc.def' }), 'abc.def');
  assert.equal(bearerOf({ Authorization: 'Basic xyz' }), null);
  assert.equal(bearerOf({ Authorization: 'Bearer <token from Auth>' }), null); // placeholder, not a token
  const now = 1_700_000_000_000;
  const live = inspectToken(jwt({ sub: 'me', exp: now / 1000 + 600 }), now);
  assert.deepEqual([live.jwt.sub, live.expired, live.expiresInMs], ['me', false, 600_000]);
  assert.equal(inspectToken(jwt({ exp: now / 1000 - 1 }), now).expired, true);
  assert.deepEqual([inspectToken('opaque', now).jwt, inspectToken(jwt({ sub: 'x' }), now).expiresAt], [null, null]);
  assert.equal(jwtPayload('a.b'), null);
});

test('send warns when the bearer token has expired', async () => {
  DB.projects = []; DB.tokenSources = [];
  const p = addProject('P');
  p.auth = { type: 'bearer', token: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }) };
  const r = addRequest(p, null, newReq({ url: 'https://api.test/x' }));
  responder = () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: '{}' });
  const res = await send({ p, f: null, r });
  assert.match(res.warnings.join(), /bearer token had expired/);
});
