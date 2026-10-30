// Turning a stored request into the wire request, sending it via the main process, and
// applying what comes back (cookies, extract rules) to the project.
import { recordVar } from './varlog.js';
import { markAutomatic } from './edits.js';
import { effectiveAuth, saveDB, setVar, uid, activeEnv, kindOf } from './store.js';
import { graphqlBody, graphqlErrors, includeDirs } from './protocols.js';
import { activeVars, resolve } from './vars.js';
import { getToken, cachedToken, tokenSource, bearerOf, inspectToken } from './tokens.js';
import { runPhase, applyRequestEdits } from './scripts.js';
import { newCorrelation } from './tasks.js';

// UTF-8 safe (btoa alone throws on non-Latin-1 characters).
export const b64utf8 = (s) => btoa(Array.from(new TextEncoder().encode(s), (c) => String.fromCharCode(c)).join(''));

const formBody = (rows, sub) => rows.filter((r) => r.on && r.k).map((r) => encodeURIComponent(sub(r.k)) + '=' + encodeURIComponent(sub(r.v))).join('&');
const BODY_CONTENT_TYPE = { json: 'application/json', form: 'application/x-www-form-urlencoded' };

// → { method, url, headers: {name: value}, body: string ('' = none), timeoutMs, redirect, missingVars: [name] }
// {{variables}} are resolved from the project's active environment.
// Header names are case-insensitive; a plain object keyed by name would send both "cookie" and
// "Cookie", which fetch merges into one comma-joined (invalid) value.
// opts.token: the token for a "token source" auth (send() fetches it first); else a cached one is used.
// opts.correlation: { requestId, traceparent } added as X-Request-Id / traceparent (unless already set).
// opts.vars: extra variables on top of the active environment (collection-runner data rows, script vars).
// opts.env: an environment to use instead of the active one (Compare → two environments).
export function buildRequest(loc, opts = {}) {
  const { r, p } = loc;
  const env = opts.env || activeEnv(p);
  const vars = { ...activeVars(env ? { envs: [env], activeEnv: env.id } : null), ...opts.vars }, missing = new Set();
  const dyn = new Map(); // {{$uuid}} etc.: one value per expression for this request
  const sub = (s) => resolve(s, vars, missing, dyn);
  const headers = {};
  const findHeader = (k) => Object.keys(headers).find((x) => x.toLowerCase() === k.toLowerCase());
  const setHeader = (k, v) => { const old = findHeader(k); if (old) delete headers[old]; headers[k] = v; };
  for (const h of r.headers) if (h.on && h.k) setHeader(sub(h.k), sub(h.v));
  const auth = effectiveAuth(loc);
  if (auth.type === 'bearer' && auth.token) setHeader('Authorization', 'Bearer ' + sub(auth.token));
  if (auth.type === 'basic') setHeader('Authorization', 'Basic ' + b64utf8(sub(auth.user || '') + ':' + sub(auth.pass || '')));
  if (auth.type === 'token') {
    const token = opts.token ?? cachedToken(auth.sourceId, p)?.token;
    setHeader('Authorization', 'Bearer ' + (token || `<token from ${tokenSource(auth.sourceId)?.name || 'missing token source'}>`));
  }
  if (p.cookies && !findHeader('Cookie')) headers['Cookie'] = p.cookies;
  if (opts.correlation) {
    if (!findHeader('X-Request-Id')) headers['X-Request-Id'] = opts.correlation.requestId;
    if (!findHeader('traceparent')) headers['traceparent'] = opts.correlation.traceparent;
  }

  let body = '';
  if (kindOf(r) === 'graphql') {
    body = graphqlBody(r, sub);
    if (!findHeader('Content-Type')) headers['Content-Type'] = 'application/json';
  } else if (!['GET', 'HEAD'].includes(r.method)) {
    if (r.body.type === 'form') body = formBody(r.body.form, sub);
    else if (r.body.type !== 'none') body = sub(r.body.text);
    const type = BODY_CONTENT_TYPE[r.body.type];
    if (body && type && !findHeader('Content-Type')) headers['Content-Type'] = type;
  }
  return {
    method: kindOf(r) === 'graphql' ? 'POST' : r.method, url: sub(r.url), headers, body,
    timeoutMs: Math.max(0, Number(r.options.timeoutSec) || 0) * 1000,
    redirect: r.options.followRedirects ? 'follow' : 'manual',
    network: env?.network || null,
    missingVars: [...missing],
  };
}

// Merge Set-Cookie values (or plain "name=value" strings) into a "a=1; b=2" cookie string,
// dropping cookies the server expires.
export function mergeCookies(cookieString, setCookies, now = Date.now()) {
  const jar = new Map((cookieString || '').split(/;\s*/).filter(Boolean).map((c) => {
    const ix = c.indexOf('='); return ix < 0 ? [c, ''] : [c.slice(0, ix), c.slice(ix + 1)];
  }));
  for (const sc of setCookies) {
    const [kv, ...attrs] = sc.split(';');
    const ix = kv.indexOf('='); if (ix < 0) continue;
    const name = kv.slice(0, ix).trim(), value = kv.slice(ix + 1).trim();
    const attr = (n) => attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith(n + '='))?.slice(n.length + 1);
    const maxAge = attr('max-age'), expires = attr('expires');
    const expired = maxAge != null ? Number(maxAge) <= 0 : !!expires && Date.parse(expires) <= now;
    if (expired) jar.delete(name); else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Extract rules (the request's "Extract" tab): k = where to read, v = where to put it.
//   k: 'data.items.0.id' (JSON body path, optional 'body.' prefix) or 'header.x-token'
//   v: 'bearer' (or empty) → project bearer token; anything else → that variable in the active environment
// → [{ path, to, value }] for the rules that found a value.
export function extractValues(rules, res) {
  let json; try { json = JSON.parse(res.body); } catch {}
  const out = [];
  for (const rule of rules || []) {
    if (!rule.on || !rule.k) continue;
    const path = rule.k.trim();
    let value;
    if (/^headers?\./i.test(path)) value = res.headers?.[path.replace(/^headers?\./i, '').toLowerCase()];
    else if (json !== undefined) value = path.replace(/^body\./, '').split('.').reduce((o, k) => o?.[k], json);
    if (value == null) continue;
    out.push({ path, to: (rule.v || '').trim() || 'bearer', value: typeof value === 'object' ? JSON.stringify(value) : String(value) });
  }
  return out;
}

function applyExtracted(p, extracted, reqName) {
  for (const { path, to, value } of extracted) {
    if (to.toLowerCase() === 'bearer') p.auth = { type: 'bearer', token: value };
    else setVar(p, to, value, { source: `${reqName}: extract ${path}`, kind: 'extract' });
  }
}

export const newSendId = () => uid();
export const cancelSend = (id) => { window.electronAPI.cancelFetch(id); window.electronAPI.grpcCancel?.(id); };

// The transport for one send: gRPC calls go to main/protocols.js, everything else to main/http.js.
function transport(loc, id, wire) {
  if (kindOf(loc.r) !== 'grpc') return window.electronAPI.doFetch({ id, ...wire, body: wire.body || undefined });
  const g = loc.r.grpc || {};
  return window.electronAPI.grpcCall({ id, url: wire.url, headers: wire.headers, body: wire.body, network: wire.network, timeoutMs: wire.timeoutMs,
    grpc: { protoFile: g.protoFile, includeDirs: includeDirs(g), service: g.service, method: g.method } });
}

// Never throws: failures come back as { error, requestData } so the UI can show them.
// Successful results also carry `warnings` (unknown variables) and `extracted` (applied extract rules).
// opts: { vars (extra variables, e.g. a runner data row), env (environment override), scripts: false to skip scripts }
export async function send(loc, id = newSendId(), opts = {}) {
  let requestData = null;
  const scriptLogs = [], scriptTests = [], scriptErrors = [];
  try {
    // "token source" auth: fetch (or reuse) the token first; on a 401, fetch a fresh one and retry once.
    const auth = effectiveAuth(loc);
    const usesSource = auth.type === 'token';
    let token = usesSource ? (await getToken(auth.sourceId, loc.p)).token : undefined;
    const correlation = loc.p.correlation !== false ? newCorrelation() : null;
    const extraVars = { ...opts.vars };
    const build = () => buildRequest(loc, { token, correlation, vars: extraVars, env: opts.env });
    let { missingVars, ...wire } = build();
    // Pre-request scripts: may set variables (then the request is rebuilt with them) and edit the request.
    if (opts.scripts !== false) {
      const env = opts.env || activeEnv(loc.p);
      const seen = structuredClone(wire); // the request as the script saw it
      const pre = await runPhase(loc, 'pre', { request: wire, vars: { ...activeVars(env ? { envs: [env], activeEnv: env.id } : null), ...extraVars } });
      scriptLogs.push(...pre.logs); scriptTests.push(...pre.tests); scriptErrors.push(...pre.errors);
      if (Object.keys(pre.setVars).length) { applyScriptVars(loc.p, pre.setVars, extraVars, opts.env, `${loc.r.name}: pre-request script`); ({ missingVars, ...wire } = build()); }
      wire = applyRequestEdits(seen, pre.request, wire);
      if (pre.errors.length) return { error: `Pre-request script failed: ${pre.errors[0]}`, requestData: wire, scriptLogs, scriptTests };
    }
    requestData = wire;
    const t0 = performance.now();
    let res = await transport(loc, id, wire);
    let tokenRefreshed = false;
    if (usesSource && res.ok && res.status === 401) {
      token = (await getToken(auth.sourceId, loc.p, { force: true })).token;
      ({ missingVars, ...wire } = buildRequest(loc, { token, correlation }));
      requestData = wire;
      res = await transport(loc, id, wire);
      tokenRefreshed = true;
    }
    if (!res.ok) return { error: res.error, cancelled: !!res.cancelled, requestData, correlation };
    // Record the headers that actually went out (defaults, Host, Content-Length) for history and Trace.
    if (res.sentHeaders) requestData = { ...requestData, headers: res.sentHeaders };
    let dirty = false;
    if (res.setCookies?.length) { loc.p.cookies = mergeCookies(loc.p.cookies, res.setCookies); dirty = true; }
    const extracted = extractValues(loc.r.chain, res);
    if (extracted.length) { applyExtracted(loc.p, extracted, loc.r.name); dirty = true; }
    if (dirty) { markAutomatic(); saveDB(); } // what a send stores isn't an edit to undo
    const warnings = missingVars.map((v) => `{{${v}}} is not defined in the active environment and was sent as written`);
    const gqlErrors = kindOf(loc.r) === 'graphql' ? graphqlErrors(res) : [];
    if (gqlErrors.length) warnings.push(`GraphQL errors: ${gqlErrors.slice(0, 3).join(' · ')}${gqlErrors.length > 3 ? ` (+${gqlErrors.length - 3} more)` : ''}`);
    if (tokenRefreshed) warnings.push('Got 401 with the cached token, so a fresh token was fetched and the request retried');
    const sentToken = !usesSource && bearerOf(wire.headers);
    if (sentToken && inspectToken(sentToken).expired) warnings.push(`The bearer token had expired (at ${new Date(inspectToken(sentToken).expiresAt).toLocaleString()}); log in again or refresh it`);
    const time = Math.round(performance.now() - t0);
    // Post-response scripts: tests, variables for later requests, and (in the runner) the next request.
    let next;
    if (opts.scripts !== false) {
      const env = opts.env || activeEnv(loc.p);
      const post = await runPhase(loc, 'post', { request: requestData, response: { status: res.status, statusText: res.statusText, headers: res.headers, body: res.body, time }, vars: { ...activeVars(env ? { envs: [env], activeEnv: env.id } : null), ...extraVars } });
      scriptLogs.push(...post.logs); scriptTests.push(...post.tests); scriptErrors.push(...post.errors);
      if (Object.keys(post.setVars).length) applyScriptVars(loc.p, post.setVars, extraVars, opts.env, `${loc.r.name}: post-response script`);
      next = post.next;
      if (post.errors.length) warnings.push(`Post-response script failed: ${post.errors[0]}`);
    }
    return { ...res, time, requestData, warnings, extracted, correlation, scriptLogs, scriptTests, next, ...(gqlErrors.length && { graphqlErrors: gqlErrors }) };
  } catch (err) {
    return { error: String(err?.message || err), requestData, scriptLogs, scriptTests };
  }
}

// vars.set() in a script: saved to the environment the request ran in (created when there is none),
// and visible to later requests of the same run.
function applyScriptVars(p, setVars, extraVars, envOverride, source) {
  for (const [k, v] of Object.entries(setVars)) {
    if (k in extraVars) extraVars[k] = v;
    if (envOverride) {
      const row = envOverride.vars.find((x) => x.k === k);
      recordVar({ p, env: envOverride, name: k, before: row?.v, value: v, secret: !!row?.secret, source, kind: 'script' });
      if (row) row.v = v; else envOverride.vars.push({ k, v, on: true });
    } else setVar(p, k, v, { source, kind: 'script' });
  }
  markAutomatic(); saveDB();
}
