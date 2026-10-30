// Request kinds besides plain HTTP: WebSocket and Server-Sent Events (live connections whose messages
// land in the tab's stream log), GraphQL (an HTTP POST built from query + variables, plus a schema
// explorer from introspection) and gRPC (unary / streaming calls from a .proto file, via main/protocols.js).
// GraphQL and gRPC go through http.js send(), so scripts, assertions, the runner and History work as usual.
import { notify } from '../shared/notify.js';
import { S, saveDB, effectiveAuth, kindOf, uid } from './store.js';
import { buildRequest } from './http.js';
import { getToken } from './tokens.js';
import { activeVars, resolve } from './vars.js';

const MAX_EVENTS = 2000;

// ── kinds ─────────────────────────────────────────────────────────────────────────────────────────
export const KIND_CHOICES = [['ws', 'WebSocket'], ['sse', 'Server-Sent Events'], ['graphql', 'GraphQL'], ['grpc', 'gRPC']];

export function setKind(r, kind) {
  if (kind === 'http') { delete r.kind; return; }
  r.kind = kind;
  if (kind === 'graphql') { r.method = 'POST'; r.graphql ||= { query: 'query {\n  \n}', variables: '' }; }
  if (kind === 'grpc') { r.method = 'POST'; r.grpc ||= { protoFile: '', includeDirs: '', service: '', method: '' }; if (!r.url || /^https?:\/\/?$/.test(r.url)) r.url = 'grpc://localhost:9090'; if (r.body.type === 'none') r.body = { type: 'json', text: '{}', form: [] }; }
  if (kind === 'ws') { r.method = 'GET'; r.ws ||= { message: '' }; r.url = r.url.replace(/^http(s?):/i, 'ws$1:'); }
  if (kind === 'sse') r.method = 'GET';
}

// The editor tabs for each kind (HTTP's are views/request.js REQUEST_TABS).
export const KIND_TABS = {
  graphql: [['query', 'Query'], ['variables', 'Variables'], ['headers', 'Headers'], ['auth', 'Auth'], ['more', 'More']],
  ws: [['message', 'Message'], ['params', 'Params'], ['headers', 'Headers'], ['auth', 'Auth']],
  sse: [['params', 'Params'], ['headers', 'Headers'], ['auth', 'Auth']],
  grpc: [['message', 'Message'], ['proto', 'Proto'], ['headers', 'Metadata'], ['auth', 'Auth'], ['more', 'More']],
};

// ── GraphQL ───────────────────────────────────────────────────────────────────────────────────────
// JSON body for a GraphQL request; sub resolves {{variables}}.
export function graphqlBody(r, sub) {
  const g = r.graphql || {};
  const body = { query: sub(g.query || '') };
  const varsText = sub(g.variables || '').trim();
  if (varsText) { try { body.variables = JSON.parse(varsText); } catch { body.variables = varsText; } }
  const ops = [...(g.query || '').matchAll(/^\s*(query|mutation|subscription)\s+(\w+)/gm)];
  if (ops.length > 1 && g.operationName) body.operationName = g.operationName;
  return JSON.stringify(body);
}

// GraphQL answers errors with HTTP 200 and an "errors" array: surface them.
export function graphqlErrors(res) {
  try { const j = JSON.parse(res.body); return Array.isArray(j?.errors) ? j.errors.map((e) => e.message || JSON.stringify(e)) : []; } catch { return []; }
}

const INTROSPECTION = `query IntrospectionQuery { __schema { queryType { name } mutationType { name } subscriptionType { name }
  types { kind name description fields(includeDeprecated: true) { name description isDeprecated args { name description type { ...T } defaultValue } type { ...T } }
    inputFields { name description type { ...T } defaultValue } enumValues(includeDeprecated: true) { name } } } }
fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }`;

export const typeName = (t) => (!t ? '?' : t.kind === 'NON_NULL' ? typeName(t.ofType) + '!' : t.kind === 'LIST' ? `[${typeName(t.ofType)}]` : t.name);
const baseType = (t) => (t?.ofType ? baseType(t.ofType) : t);

export const gqlSchemas = new Map(); // request id → { schema, at } | { error }

export async function fetchGraphqlSchema(loc) {
  const auth = effectiveAuth(loc);
  let token;
  try { if (auth.type === 'token') token = (await getToken(auth.sourceId, loc.p)).token; } catch (err) { return notify(err.message, 'error'); }
  const { missingVars, ...wire } = buildRequest(loc, { token });
  const res = await window.electronAPI.doFetch({ id: uid(), ...wire, method: 'POST', headers: { ...wire.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: INTROSPECTION }) });
  let schema = null, error = null;
  if (!res.ok) error = res.error;
  else {
    try {
      const j = JSON.parse(res.body);
      schema = j.data?.__schema;
      if (!schema) error = j.errors?.[0]?.message || `HTTP ${res.status}: no schema in the response (introspection may be disabled)`;
    } catch { error = `HTTP ${res.status}: the response isn't JSON`; }
  }
  gqlSchemas.set(loc.r.id, schema ? { schema, at: Date.now() } : { error });
  if (error) notify('Schema: ' + error, 'error', 7000);
}

// A query skeleton for a root field: required args as $variables, scalar fields selected one level deep.
export function fieldSkeleton(schema, rootKind, field) {
  const types = new Map(schema.types.map((t) => [t.name, t]));
  const args = field.args.filter((a) => a.type.kind === 'NON_NULL');
  const vars = args.map((a) => `$${a.name}: ${typeName(a.type)}`).join(', ');
  const call = args.length ? `(${args.map((a) => `${a.name}: $${a.name}`).join(', ')})` : '';
  const select = (type, depth) => {
    const t = types.get(baseType(type)?.name);
    if (!t?.fields) return '';
    const scalars = t.fields.filter((f) => ['SCALAR', 'ENUM'].includes(baseType(f.type)?.kind)).slice(0, 12).map((f) => f.name);
    const pad = '  '.repeat(depth + 1);
    return scalars.length ? ` {\n${scalars.map((n) => pad + '  ' + n).join('\n')}\n${pad}}` : ` {\n${pad}  __typename\n${pad}}`;
  };
  const op = rootKind === 'mutation' ? 'mutation' : rootKind === 'subscription' ? 'subscription' : 'query';
  const opName = field.name[0].toUpperCase() + field.name.slice(1);
  return `${op} ${opName}${vars ? `(${vars})` : ''} {\n  ${field.name}${call}${select(field.type, 0)}\n}`;
}

// ── gRPC ──────────────────────────────────────────────────────────────────────────────────────────
export const grpcDescriptions = new Map(); // proto file → { services } | { error }

export async function describeProto(r) {
  const g = r.grpc;
  if (!g?.protoFile) return notify('Choose a .proto file first', 'error');
  const res = await window.electronAPI.grpcDescribe({ protoFile: g.protoFile, includeDirs: includeDirs(g) });
  grpcDescriptions.set(g.protoFile, res.ok ? { services: res.services } : { error: res.error });
  if (!res.ok) return notify(res.error, 'error', 8000);
  // Pick the first method when none is chosen yet.
  const svc = res.services.find((s) => s.name === g.service) || res.services[0];
  if (svc && !svc.methods.some((m) => m.name === g.method)) { g.service = svc.name; g.method = svc.methods[0]?.name || ''; }
  saveDB();
}

export const includeDirs = (g) => (g.includeDirs || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
export const grpcMethod = (g) => grpcDescriptions.get(g?.protoFile)?.services?.find((s) => s.name === g.service)?.methods.find((m) => m.name === g.method) || null;

// ── WebSocket / SSE streams ───────────────────────────────────────────────────────────────────────
// tab.stream: { kind, connId, state: 'connecting' | 'open' | 'closed', events: [{ dir: 'in' | 'out' | 'sys', at, data, event?, binary?, size? }], url, handshake }
let onChange = () => {};
export function wireStreams(rerender) {
  onChange = rerender;
  window.electronAPI.onStreamEvent((proto, e) => {
    const tab = S.tabs.find((t) => t.stream?.connId === e.id); if (!tab) return;
    const st = tab.stream, before = st.state;
    const push = (ev) => { st.events.unshift({ at: e.at, ...ev }); if (st.events.length > MAX_EVENTS) st.events.length = MAX_EVENTS; };
    if (e.type === 'handshake' || (proto === 'sse' && e.type === 'open')) st.handshake = { status: e.status, headers: e.headers };
    if (e.type === 'open') { st.state = 'open'; push({ dir: 'sys', data: proto === 'ws' ? `Connected${e.protocol ? ` (subprotocol ${e.protocol})` : ''} in ${e.ms} ms` : `HTTP ${e.status}, listening (${e.ms} ms)` }); }
    if (e.type === 'message') push(proto === 'ws' ? { dir: 'in', data: e.data, binary: e.binary, size: e.size } : { dir: 'in', event: e.event, data: e.data, lastEventId: e.lastEventId });
    if (e.type === 'error') push({ dir: 'sys', error: true, data: e.message + (e.body ? `\n${e.body}` : '') });
    if (e.type === 'close') { st.state = 'closed'; push({ dir: 'sys', data: proto === 'ws' ? `Closed (${e.code}${e.reason ? ': ' + e.reason : ''})` : e.stopped ? 'Stopped' : 'Stream ended' }); }
    onChange(tab, before !== st.state);
  });
}

export async function startStream(loc, tab) {
  const kind = kindOf(loc.r);
  const auth = effectiveAuth(loc);
  let token;
  try { if (auth.type === 'token') token = (await getToken(auth.sourceId, loc.p)).token; } catch (err) { return notify(err.message, 'error'); }
  const { missingVars, ...wire } = buildRequest(loc, { token });
  if (missingVars.length) notify(`{{${missingVars.join('}}, {{')}}} not defined — sent as written`, 'error');
  const connId = uid();
  const url = kind === 'ws' ? wire.url.replace(/^http(s?):/i, 'ws$1:') : wire.url;
  tab.stream = { kind, connId, state: 'connecting', events: [{ dir: 'sys', at: Date.now(), data: `${kind === 'ws' ? 'Connecting to' : 'Opening'} ${url}` }], url };
  onChange(tab, true);
  const headers = Object.fromEntries(Object.entries(wire.headers).filter(([k]) => !/^content-type$/i.test(k)));
  const res = kind === 'ws'
    ? await window.electronAPI.wsConnect({ id: connId, url, headers, network: wire.network })
    : await window.electronAPI.sseStart({ id: connId, url, headers, network: wire.network });
  if (!res.ok) { tab.stream.state = 'closed'; tab.stream.events.unshift({ dir: 'sys', error: true, at: Date.now(), data: res.error }); onChange(tab, true); }
}

export function stopStream(tab) {
  const st = tab?.stream; if (!st || st.state === 'closed') return;
  if (st.kind === 'ws') window.electronAPI.wsClose({ id: st.connId }); else window.electronAPI.sseStop(st.connId);
}

export async function sendWsMessage(loc, tab) {
  const st = tab?.stream;
  if (st?.state !== 'open') return notify('Connect first', 'error');
  const text = resolve(loc.r.ws?.message || '', activeVars(loc.p));
  const res = await window.electronAPI.wsSend({ id: st.connId, data: text });
  if (!res.ok) return notify(res.error, 'error');
  st.events.unshift({ dir: 'out', at: Date.now(), data: text, size: new TextEncoder().encode(text).length });
  onChange(tab, false);
}

export const isStreaming = (tab) => tab?.stream && tab.stream.state !== 'closed';
