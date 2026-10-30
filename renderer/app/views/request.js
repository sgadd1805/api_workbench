import { $, esc } from '../../shared/html.js';
import { isJson } from '../../shared/json.js';
import { DB, S, activeTab, kindOf } from '../store.js';
import { queryRows } from '../query.js';
import { kvRows } from './kv.js';
import { specTabBadge, opSummaryHtml } from './specs.js';
import { tokenChipHtml } from './tokenchip.js';
import { codeEditorHtml, urlFieldHtml } from '../editor.js';
import { langFor } from '../../shared/highlight.js';
import { KIND_CHOICES, KIND_TABS } from '../protocols.js';
import { KIND_TAB_BODIES } from './kinds.js';
import { icon } from '../../shared/icons.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const AUTH_TYPES = [['inherit', 'inherit'], ['none', 'none'], ['bearer', 'bearer'], ['basic', 'basic'], ['token', 'token source']];
const BODY_TYPES = [['none', 'none'], ['raw', 'raw'], ['json', 'JSON'], ['form', 'form (urlencoded)']];

// Spec and Git live in the side panel (views/layout.js); Extract, Assertions and Options under More.
export const REQUEST_TABS = [['params', 'Params'], ['headers', 'Headers'], ['body', 'Body'], ['auth', 'Auth'], ['more', 'More']];
const OLD_TAB = { extract: 'more', assert: 'more', options: 'more', spec: 'params', git: 'params' };

// "token source" auth: which source, and a link to manage them.
function tokenAuthHtml(auth) {
  if (!DB.tokenSources.length) return '<p class="mt-6 hint">No token sources yet. <button class="link-btn" data-action="open-tokens">Create one…</button></p>';
  return `<div class="mt-6 spec-row"><select id="auth-source">${DB.tokenSources.map((t) => `<option value="${esc(t.id)}" ${t.id === auth.sourceId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    <button class="link-btn" data-action="open-tokens" data-id="${esc(auth.sourceId || '')}">Manage token sources…</button></div>
    <p class="hint">The token is fetched before sending (and again after a 401), then sent as <code>Authorization: Bearer …</code>.</p>`;
}

// Pre-request / post-response JavaScript (renderer/app/scripts.js documents what scripts can use).
function scriptsHtml(r) {
  return `<details class="script-help"><summary class="hint">What scripts can use</summary><div class="hint md">
      <code>request</code> {method, url, headers, body} (editable before sending) · <code>response</code> {status, headers, body, json(), header(name)} ·
      <code>vars.get(n)</code> / <code>vars.set(n, v)</code> (saved to the active environment) · <code>log(…)</code> ·
      <code>test(name, () => …)</code> with <code>expect(x).toBe(y)</code> · <code>ctx.crypto.hmac('SHA-256', key, msg)</code>, <code>ctx.uuid()</code>, <code>ctx.now()</code> ·
      <code>ctx.setNextRequest(name)</code> in the collection runner. Scripts may <code>await</code>; each has 5 s. Project-wide scripts (Project settings) run first.</div></details>
    <label class="hint">Before sending</label>
    ${codeEditorHtml({ id: 'script-pre', value: r.scripts.pre, lang: 'js', rows: 5, placeholder: "request.headers['X-Signature'] = await ctx.crypto.hmac('SHA-256', vars.get('secret'), request.body);" })}
    <label class="mt-6 block hint">After the response</label>
    ${codeEditorHtml({ id: 'script-post', value: r.scripts.post, lang: 'js', rows: 5, placeholder: "test('created', () => expect(response.status).toBe(201));\nvars.set('petId', response.json().id);" })}`;
}

// Small status line under the JSON body editor; updated in place while typing.
export function jsonStatus(text) {
  if (!text.trim()) return '';
  return isJson(text) ? '<span class="assert-pass">✓ valid JSON</span>' : '<span class="assert-fail">✗ invalid JSON (still sent as typed)</span>';
}

const TAB_BODIES = {
  params: (r) => `<p class="mb-6 hint">Edits here rewrite the URL's query string.</p>`
    + kvRows(queryRows(r.url), 'params', { toggle: false, extraRow: activeTab()?.pendingParam }),
  headers: (r) => kvRows(r.headers, 'headers', { keyPh: 'Header', valPh: 'value (may use {{variables}})' }),
  body(r) {
    const radios = BODY_TYPES.map(([t, label]) =>
      `<label class="mr-10"><input type="radio" name="body_type" value="${t}" ${r.body.type === t ? 'checked' : ''}/> ${label}</label>`).join('');
    let editor = '';
    const contentType = r.headers.find((h) => h.on !== false && /^content-type$/i.test(h.k))?.v;
    if (r.body.type === 'raw') editor = codeEditorHtml({ id: 'body-text', value: r.body.text, lang: langFor(contentType), rows: 10 });
    if (r.body.type === 'json') editor = `${codeEditorHtml({ id: 'body-text', value: r.body.text, lang: 'json', rows: 10, placeholder: '{"key": "{{value}}"}' })}
      <div style="display:flex;gap:10px;align-items:center;margin-top:4px"><button class="btn-ghost small" data-action="format-json-body">Format</button><span id="json-status" class="hint">${jsonStatus(r.body.text)}</span></div>`;
    if (r.body.type === 'form') editor = kvRows(r.body.form, 'form');
    const note = r.body.type === 'json' || r.body.type === 'form' ? '<p class="mt-6 hint">Content-Type is set automatically unless you add one in Headers.</p>' : '';
    return `<div class="mb-6">${radios}</div>${editor}${note}`;
  },
  auth: (r) => `<select id="auth-type">${AUTH_TYPES.map(([t, label]) => `<option value="${t}" ${r.auth.type === t ? 'selected' : ''}>${label}</option>`).join('')}</select>
      ${r.auth.type === 'token' ? tokenAuthHtml(r.auth) : ''}
      ${r.auth.type === 'bearer' ? `<div class="mt-6"><input type="text" id="auth-token" class="w-full" placeholder="token or {{variable}}" value="${esc(r.auth.token || '')}"/></div>` : ''}
      ${r.auth.type === 'basic' ? `<div class="mt-6 row gap-6"><input type="text" id="auth-user" placeholder="user" value="${esc(r.auth.user || '')}"/><input type="password" id="auth-pass" placeholder="pass" value="${esc(r.auth.pass || '')}"/></div>` : ''}
      ${r.auth.type === 'inherit' ? '<p class="mt-6 hint">Uses the folder\'s auth, else the project\'s (project ⋯ menu).</p>' : ''}`,
  more: (r) => `<h4 class="section-title">Extract</h4>${TAB_BODIES.extract(r)}
    <h4 class="mt-14 section-title">Assertions</h4>${TAB_BODIES.assert(r)}
    <h4 class="mt-14 section-title">Options</h4>${TAB_BODIES.options(r)}
    <h4 class="mt-14 section-title">Scripts</h4>${scriptsHtml(r)}`,
  extract: (r) => `<p class="mb-6 hint">After a successful send, copy values from the response.
      Source: a JSON path like <code>data.token</code> or <code>items.0.id</code>, or <code>header.x-token</code>.
      Target: <code>bearer</code> (the project's bearer token) or a variable name for the active environment.</p>`
    + kvRows(r.chain, 'chain', { keyPh: 'source, e.g. data.token', valPh: 'target: bearer or variable name' }),
  assert: (r) => `<p class="mb-6 hint">JS expressions using <code>status</code> and <code>body</code> (parsed JSON if possible).</p>
      <textarea id="assert-text" rows="5" spellcheck="false" placeholder="status === 200&#10;body.ok === true">${esc((r.assertions || []).join('\n'))}</textarea>`,
  options: (r) => `<div style="display:flex;flex-direction:column;gap:8px">
      <label>Timeout <input type="text" id="opt-timeout" class="w-70" value="${esc(r.options.timeoutSec)}"/> seconds <span class="hint">(0 = none)</span></label>
      <label><input type="checkbox" id="opt-redirects" ${r.options.followRedirects ? 'checked' : ''}/> Follow redirects <span class="hint">(off: the 3xx response itself is shown)</span></label></div>`,
};

// The editor tabs for the request's kind; a tab that doesn't exist for it falls back to the first.
export function tabsFor(r) {
  const tabs = KIND_TABS[kindOf(r)] || REQUEST_TABS;
  const t = activeTab();
  if (t && OLD_TAB[t.editorTab]) t.editorTab = OLD_TAB[t.editorTab];
  if (t && !tabs.some(([id]) => id === t.editorTab)) t.editorTab = tabs[0][0];
  return tabs;
}

export function renderTabBody(r) {
  tabsFor(r);
  const id = activeTab()?.editorTab;
  return (KIND_TAB_BODIES[id] || TAB_BODIES[id])?.(r) ?? '';
}

// Method picker: HTTP methods, then the other protocols (value "kind:ws" …).
function methodSelectHtml(r) {
  const kind = kindOf(r);
  return `<select class="method-select" id="method-select" title="Method or protocol">${METHODS.map((m) => `<option ${kind === 'http' && m === r.method ? 'selected' : ''}>${m}</option>`).join('')}
    <optgroup label="Other protocols">${KIND_CHOICES.map(([k, label]) => `<option value="kind:${k}" ${kind === k ? 'selected' : ''}>${label}</option>`).join('')}</optgroup></select>`;
}

// Send button per kind: WebSocket connects, SSE listens; both disconnect while open.
function sendButtonHtml(r, t) {
  const kind = kindOf(r);
  if (kind === 'ws' || kind === 'sse') {
    const live = t.stream && t.stream.state !== 'closed';
    return live ? `<button class="btn-primary danger" data-action="stream-stop">${kind === 'ws' ? 'Disconnect' : 'Stop'}</button>`
      : `<button class="btn-primary" data-action="send">${kind === 'ws' ? 'Connect' : 'Listen'}</button>`;
  }
  return t.sending ? '<button class="btn-primary danger" data-action="cancel-send">Cancel</button>' : '<button class="btn-primary" data-action="send">Send</button>';
}

// Re-render just the tab body (e.g. Params after the URL changes) so the URL input keeps focus.
export function refreshTabBody() {
  const el = document.querySelector('#request-panel .tab-body');
  if (el && S.req) el.innerHTML = renderTabBody(S.req);
}

export function renderRequestPanel() {
  const r = S.req, t = activeTab();
  const el = $('request-panel');
  if (!r || !t || S.page !== 'request') return; // the workspace is hidden (views/layout.js renderSplit)
  if (OLD_TAB[t.editorTab]) t.editorTab = OLD_TAB[t.editorTab];
  el.innerHTML = `<div class="url-bar">
      ${methodSelectHtml(r)}
      ${urlFieldHtml(r.url)}
      ${sendButtonHtml(r, t)}
      ${['http', 'graphql'].includes(kindOf(r)) ? '<button class="btn-ghost" data-action="copy-curl" title="Copy as cURL">cURL</button><button class="btn-ghost" data-action="copy-code" title="Copy as fetch, axios, Python, Java or C#">Code ▾</button>' : ''}
      <button class="btn-ghost" data-action="duplicate-req" title="Duplicate request">Duplicate</button>
      <button class="btn-ghost" data-action="side-open" data-tab="spec" title="Spec: docs and checks for this request">Spec${specTabBadge(r) ? ' ' + specTabBadge(r) : ''}</button>
      <button class="btn-ghost" data-action="request-menu" title="Rename, move, add to feature, delete">${icon('more')}</button></div>
    ${opSummaryHtml(r)}${tokenChipHtml(r)}
    <div class="tabs">${tabsFor(r).map(([id, label]) => {
      const count = id === 'headers' ? r.headers.length : id === 'more' ? r.chain.length + r.assertions.filter((a) => a.trim()).length + (r.scripts.pre.trim() ? 1 : 0) + (r.scripts.post.trim() ? 1 : 0) : 0;
      const badge = count ? `<span class="hint">${count}</span>` : '';
      return `<button class="tab${t.editorTab === id ? ' active' : ''}" data-action="tab" data-tab="${id}">${label}${badge ? ' ' + badge : ''}</button>`;
    }).join('')}</div>
    <div class="tab-body">${renderTabBody(r)}</div>`;
}
