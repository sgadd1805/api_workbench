// Actions for WebSocket / SSE / GraphQL / gRPC requests (renderer/app/protocols.js).
import { notify } from '../../shared/notify.js';
import { S, saveDB, findReq, activeTab, kindOf } from '../store.js';
import { renderRequestPanel, renderResponsePanel, refreshTabBody, renderTabBar, renderSidebar } from '../views/index.js';
import { streamStatusHtml, streamLogHtml } from '../views/kinds.js';
import { KIND_TABS, setKind, startStream, stopStream, sendWsMessage, fetchGraphqlSchema, gqlSchemas, fieldSkeleton, describeProto, grpcMethod, wireStreams } from '../protocols.js';

const loc = () => S.req && findReq(S.req.id);

// Stream events: update the log in place; re-render the editor when the connection state changed.
export function initStreams() {
  wireStreams((tab, stateChanged) => {
    if (S.page !== 'request' || activeTab() !== tab) { if (stateChanged) renderTabBar(); return; }
    refreshStreamView(tab);
    if (stateChanged) { renderRequestPanel(); renderTabBar(); }
  });
}

function refreshStreamView(tab) {
  const st = document.getElementById('stream-status'), log = document.getElementById('stream-log');
  if (!st || !log) return renderResponsePanel();
  st.innerHTML = streamStatusHtml(tab.stream);
  log.innerHTML = streamLogHtml(tab.stream);
}

// ⌘Enter / Send for WebSocket and SSE requests. → true if handled.
export function sendStreamRequest() {
  const l = loc(), tab = activeTab();
  if (!l || !tab || !['ws', 'sse'].includes(kindOf(l.r))) return false;
  const live = tab.stream && tab.stream.state !== 'closed';
  if (live && kindOf(l.r) === 'ws') sendWsMessage(l, tab);
  else if (!live) startStream(l, tab);
  return true;
}

export const protocolActions = {
  'stream-stop'() { stopStream(activeTab()); },
  'stream-clear'() { const t = activeTab(); if (t?.stream) { t.stream.events = []; refreshStreamView(t); } },
  'ws-send'() { const l = loc(); if (l) sendWsMessage(l, activeTab()); },
  async 'gql-schema'(_d, el) {
    const l = loc(); if (!l) return;
    if (el) { el.disabled = true; el.textContent = 'Fetching…'; }
    await fetchGraphqlSchema(l);
    refreshTabBody();
  },
  'gql-insert'(d) {
    const l = loc(), s = gqlSchemas.get(l?.r.id)?.schema; if (!s) return;
    const rootName = { query: s.queryType, mutation: s.mutationType, subscription: s.subscriptionType }[d.kind]?.name;
    const field = s.types.find((t) => t.name === rootName)?.fields.find((f) => f.name === d.field); if (!field) return;
    l.r.graphql.query = fieldSkeleton(s, d.kind, field);
    const vars = field.args.filter((a) => a.type.kind === 'NON_NULL');
    if (vars.length && !l.r.graphql.variables.trim()) l.r.graphql.variables = JSON.stringify(Object.fromEntries(vars.map((a) => [a.name, null])), null, 2);
    saveDB(); refreshTabBody();
  },
  async 'grpc-browse'() {
    const file = await window.electronAPI.pickFile({ title: 'Choose a .proto file', filters: [{ name: 'Protocol Buffers', extensions: ['proto'] }] });
    const l = loc(); if (!file || !l) return;
    l.r.grpc.protoFile = file; saveDB();
    await describeProto(l.r); fillTemplate(l.r); refreshTabBody();
  },
  async 'grpc-describe'() { const l = loc(); if (!l) return; await describeProto(l.r); fillTemplate(l.r); refreshTabBody(); },
  'grpc-template'() {
    const l = loc(), m = grpcMethod(l?.r.grpc); if (!m) return;
    l.r.body = { type: 'json', text: m.requestStream ? `[\n${m.template}\n]` : m.template, form: [] }; saveDB(); refreshTabBody();
  },
};

// A freshly picked method gets its message template when the body is still empty.
function fillTemplate(r) {
  const m = grpcMethod(r.grpc);
  if (m && (!r.body.text.trim() || r.body.text.trim() === '{}')) r.body = { type: 'json', text: m.requestStream ? `[\n${m.template}\n]` : m.template, form: [] };
  saveDB();
}

// 'change' handlers for these kinds. → true if handled.
export function onProtocolChange(el) {
  const l = loc(); if (!l) return false;
  const r = l.r;
  if (el.id === 'method-select') {
    if (activeTab()?.stream && activeTab().stream.state !== 'closed') stopStream(activeTab());
    const before = kindOf(r);
    if (el.value.startsWith('kind:')) setKind(r, el.value.slice(5)); else { setKind(r, 'http'); r.method = el.value; }
    // A different protocol starts on its main tab (Message, Query…).
    if (kindOf(r) !== before && activeTab()) activeTab().editorTab = (KIND_TABS[kindOf(r)] || [['params']])[0][0];
    saveDB(); renderRequestPanel(); renderResponsePanel(); renderSidebar(); renderTabBar();
    return true;
  }
  if (el.id === 'grpc-service') { r.grpc.service = el.value; r.grpc.method = ''; describeProto(r).then(() => { fillTemplate(r); refreshTabBody(); }); return true; }
  if (el.id === 'grpc-method') { r.grpc.method = el.value; fillTemplate(r); refreshTabBody(); return true; }
  return false;
}

// 'input' handlers. → true if handled.
export function onProtocolInput(el) {
  const l = loc();
  if (el.id === 'stream-filter') { S.streamFilter = el.value; const t = activeTab(); if (t?.stream) document.getElementById('stream-log').innerHTML = streamLogHtml(t.stream); return true; }
  if (el.id === 'gql-filter') {
    S.gqlFilter = el.value; const at = el.selectionStart;
    refreshTabBody();
    const again = document.getElementById('gql-filter'); again?.focus(); again?.setSelectionRange(at, at);
    return true;
  }
  if (!l) return false;
  const r = l.r;
  const set = { 'gql-query': () => { r.graphql.query = el.value; }, 'gql-vars': () => { r.graphql.variables = el.value; }, 'ws-message': () => { r.ws.message = el.value; },
    'grpc-proto': () => { r.grpc.protoFile = el.value.trim(); }, 'grpc-includes': () => { r.grpc.includeDirs = el.value; } }[el.id];
  if (!set) return false;
  set(); saveDB();
  return true;
}
