// Editor tabs and response views for the other request kinds (renderer/app/protocols.js):
// GraphQL Query / Variables with a schema explorer, gRPC Message / Proto, WebSocket Message,
// and the live stream log that replaces the response for WebSocket and SSE.
import { esc } from '../../shared/html.js';
import { prettyJson, isJson } from '../../shared/json.js';
import { highlight } from '../../shared/highlight.js';
import { S, activeTab } from '../store.js';
import { codeEditorHtml } from '../editor.js';
import { gqlSchemas, typeName, grpcDescriptions, grpcMethod } from '../protocols.js';

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(t % 1000).padStart(3, '0');

// ── GraphQL ───────────────────────────────────────────────────────────────────────────────────────
function explorerHtml(r) {
  const s = gqlSchemas.get(r.id);
  const head = `<div class="mt-8 spec-row"><button class="btn-ghost small" data-action="gql-schema">${s?.schema ? 'Refresh schema' : 'Fetch schema'}</button>
    <span class="hint">${s?.schema ? `${s.schema.types.filter((t) => !t.name.startsWith('__')).length} types, loaded ${new Date(s.at).toLocaleTimeString()}` : s?.error ? esc(s.error) : 'Introspects the endpoint (same URL, headers and auth)'}</span></div>`;
  if (!s?.schema) return head;
  const roots = [['query', s.schema.queryType], ['mutation', s.schema.mutationType], ['subscription', s.schema.subscriptionType]].filter(([, t]) => t);
  const types = new Map(s.schema.types.map((t) => [t.name, t]));
  const q = (S.gqlFilter || '').toLowerCase();
  const sections = roots.map(([kind, ref]) => {
    const fields = (types.get(ref.name)?.fields || []).filter((f) => !q || f.name.toLowerCase().includes(q));
    if (!fields.length) return '';
    return `<details class="gql-root" open><summary class="hint">${kind} (${fields.length})</summary>${fields.map((f) => `
      <div class="gql-field${f.isDeprecated ? ' deprecated' : ''}" title="${esc(f.description || '')}">
        <button class="btn-ghost small" data-action="gql-insert" data-kind="${kind}" data-field="${esc(f.name)}" title="Replace the query with this field">Use</button>
        <code>${esc(f.name)}${f.args.length ? `(${f.args.map((a) => `${esc(a.name)}: ${esc(typeName(a.type))}`).join(', ')})` : ''}: ${esc(typeName(f.type))}</code>
        ${f.description ? `<span class="hint">${esc(f.description.split('\n')[0].slice(0, 100))}</span>` : ''}</div>`).join('')}</details>`;
  }).join('');
  const named = s.schema.types.filter((t) => !t.name.startsWith('__') && ['OBJECT', 'INPUT_OBJECT', 'ENUM', 'INTERFACE', 'UNION'].includes(t.kind) && !roots.some(([, r2]) => r2.name === t.name) && (!q || t.name.toLowerCase().includes(q)));
  const typesHtml = `<details class="gql-root"><summary class="hint">Types (${named.length})</summary>${named.map((t) => `<details class="gql-type"><summary><code>${esc(t.name)}</code> <span class="hint">${t.kind.toLowerCase().replace('_', ' ')}</span></summary>
      ${(t.fields || t.inputFields || []).map((f) => `<div class="gql-field"><code>${esc(f.name)}: ${esc(typeName(f.type))}</code>${f.description ? ` <span class="hint">${esc(f.description.split('\n')[0].slice(0, 80))}</span>` : ''}</div>`).join('')}
      ${t.enumValues ? `<div class="hint">${t.enumValues.map((v) => esc(v.name)).join(' · ')}</div>` : ''}</details>`).join('')}</details>`;
  return `${head}<input type="text" id="gql-filter" value="${esc(S.gqlFilter || '')}" placeholder="Filter fields and types" spellcheck="false" class="my-6 w-full"/>
    <div class="gql-explorer">${sections}${typesHtml}</div>`;
}

export const KIND_TAB_BODIES = {
  query: (r) => `${codeEditorHtml({ id: 'gql-query', value: r.graphql?.query || '', lang: 'graphql', rows: 12, placeholder: 'query {\n  users { id name }\n}' })}${explorerHtml(r)}`,
  variables: (r) => `<p class="mb-6 hint">JSON, sent as <code>variables</code>. {{variables}} from the environment are resolved first.</p>
    ${codeEditorHtml({ id: 'gql-vars', value: r.graphql?.variables || '', lang: 'json', rows: 8, placeholder: '{ "id": "{{userId}}" }' })}`,
  message(r) {
    if (r.kind === 'ws') {
      const t = activeTab(), open = t?.stream?.state === 'open';
      return `${codeEditorHtml({ id: 'ws-message', value: r.ws?.message || '', lang: isJson(r.ws?.message || '') ? 'json' : 'text', rows: 8, placeholder: '{"type": "subscribe", "channel": "orders"}' })}
        <div class="mt-6 spec-row"><button class="btn-primary small" data-action="ws-send" ${open ? '' : 'disabled'} title="${/^Mac/.test(navigator.platform) ? '⌘Enter' : 'Ctrl+Enter'} while typing">Send message</button>
        <span class="hint">${open ? 'Connected' : 'Connect first'} · {{variables}} are resolved when sending</span></div>`;
    }
    const m = grpcMethod(r.grpc);
    return `${codeEditorHtml({ id: 'body-text', value: r.body.text, lang: 'json', rows: 10, placeholder: '{ "id": "42" }' })}
      <div class="mt-6 spec-row">${m ? `<button class="btn-ghost small" data-action="grpc-template" title="Replace with an empty ${esc(m.requestType || 'message')}">Template</button>
        <span class="hint">${esc(m.requestType || '')}${m.requestStream ? ' (client stream: send a JSON array of messages)' : ''} → ${esc(m.responseType || '')}${m.responseStream ? ' (stream)' : ''}</span>` : '<span class="hint">Load the .proto on the Proto tab to pick a method and get a template.</span>'}</div>`;
  },
  proto(r) {
    const g = r.grpc || {}, d = grpcDescriptions.get(g.protoFile);
    const services = d?.services || [];
    const svc = services.find((s) => s.name === g.service);
    return `<label class="hint" for="grpc-proto">.proto file</label>
      <div class="spec-row"><input type="text" id="grpc-proto" value="${esc(g.protoFile || '')}" placeholder="/path/to/service.proto" spellcheck="false" class="grow"/>
        <button class="btn-ghost small" data-action="grpc-browse">Browse…</button><button class="btn-primary small" data-action="grpc-describe">Load</button></div>
      <label class="hint" for="grpc-includes">Import paths (for imports of other .proto files; comma or newline separated)</label>
      <input type="text" id="grpc-includes" value="${esc(g.includeDirs || '')}" spellcheck="false" class="w-full"/>
      ${d?.error ? `<p class="error-text">${esc(d.error)}</p>` : ''}
      ${services.length ? `<div class="mt-8 spec-row">
        <label class="hint" for="grpc-service">Service</label><select id="grpc-service">${services.map((s) => `<option ${s.name === g.service ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <label class="hint" for="grpc-method">Method</label><select id="grpc-method">${(svc?.methods || []).map((m) => `<option value="${esc(m.name)}" ${m.name === g.method ? 'selected' : ''}>${esc(m.name)}${m.requestStream || m.responseStream ? ` (${m.requestStream ? 'client' : ''}${m.requestStream && m.responseStream ? '/' : ''}${m.responseStream ? 'server' : ''} stream)` : ''}</option>`).join('')}</select></div>`
        : g.service ? `<p class="hint">Calls <code>${esc(g.service)}/${esc(g.method)}</code>. Load the file to change it.</p>` : ''}
      <p class="mt-8 hint">Address in the URL box: <code>grpc://host:port</code> (plaintext) or <code>grpcs://host:port</code> (TLS, using the environment's network settings).
        Metadata comes from the Metadata tab and auth; responses map gRPC status codes to HTTP ones (NOT_FOUND → 404, UNAVAILABLE → 503 …) so assertions and the runner work.</p>`;
  },
};

// ── stream log (WebSocket / SSE response area) ───────────────────────────────────────────────────
function eventHtml(e) {
  const icon = e.dir === 'out' ? '↑' : e.dir === 'in' ? '↓' : '•';
  const data = e.binary ? `(binary, ${e.size} bytes) ${esc(e.data.slice(0, 120))}…` : isJson(e.data) ? highlight(prettyJson(e.data), 'json') : esc(e.data);
  const long = !e.binary && e.data.length > 600;
  return `<div class="stream-ev ${e.dir}${e.error ? ' err' : ''}"><span class="stream-dir">${icon}</span><span class="hint stream-time">${fmtTime(e.at)}</span>
    ${e.event && e.event !== 'message' ? `<span class="stream-event">${esc(e.event)}</span>` : ''}
    ${long ? `<details class="stream-data"><summary>${esc(e.data.slice(0, 160))}…</summary><pre>${data}</pre></details>` : `<pre class="stream-data">${data}</pre>`}</div>`;
}

export function streamStatusHtml(st) {
  if (!st) return '<span class="hint">Not connected</span>';
  const cls = st.state === 'open' ? 'status-ok' : st.state === 'connecting' ? 'warn-text' : 'hint';
  const ins = st.events.filter((e) => e.dir === 'in').length, outs = st.events.filter((e) => e.dir === 'out').length;
  return `<span class="${cls}">● ${st.state}</span><span class="hint">${esc(st.url || '')}</span><span class="hint">↓ ${ins} · ↑ ${outs}</span>
    ${st.handshake ? `<details class="stream-hs"><summary class="hint">HTTP ${st.handshake.status}</summary><pre class="resp-body">${esc(Object.entries(st.handshake.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'))}</pre></details>` : ''}`;
}

export function streamLogHtml(st) {
  const q = (S.streamFilter || '').toLowerCase();
  const evs = (st?.events || []).filter((e) => !q || `${e.event || ''} ${e.data}`.toLowerCase().includes(q));
  return evs.slice(0, 500).map(eventHtml).join('') || '<p class="hint">No messages yet.</p>';
}

export function streamPanelHtml(r, t) {
  const st = t?.stream;
  return `<div class="status-line" id="stream-status">${streamStatusHtml(st)}</div>
    <div class="spec-row"><input type="text" id="stream-filter" value="${esc(S.streamFilter || '')}" placeholder="Filter messages" spellcheck="false" class="grow"/>
      <button class="btn-ghost small" data-action="stream-clear" ${st?.events.length ? '' : 'disabled'}>Clear</button></div>
    <div class="stream-log" id="stream-log">${st ? streamLogHtml(st) : `<p class="hint">${r.kind === 'ws' ? 'Connect to open the WebSocket; messages both ways appear here, newest first.' : 'Listen to open the event stream; events appear here as they arrive, newest first.'}</p>`}</div>`;
}
