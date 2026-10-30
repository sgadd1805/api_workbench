// Token Sources page: requests that fetch access tokens for the "token source" auth type.
import { esc } from '../../shared/html.js';
import { DB, S, currentProject } from '../store.js';
import { tokenSource, cachedToken } from '../tokens.js';
import { kvRows } from './kv.js';
import { icon } from '../../shared/icons.js';

const METHODS = ['POST', 'GET', 'PUT'];
const BODY_TYPES = [['none', 'none'], ['raw', 'raw'], ['json', 'JSON'], ['form', 'form (urlencoded)']];
const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString() : '');
const mask = (t) => (t.length > 24 ? `${t.slice(0, 12)}…${t.slice(-6)}` : t);

export const selectedTokenSource = () => tokenSource(S.tokens.id) || DB.tokenSources[0] || null;

function editorHtml(src) {
  const p = currentProject();
  const cached = cachedToken(src.id, p);
  const test = S.tokens.test?.id === src.id ? S.tokens.test : null;
  const radios = BODY_TYPES.map(([t, label]) => `<label class="mr-10"><input type="radio" name="ts_body_type" value="${t}" ${src.body.type === t ? 'checked' : ''}/> ${label}</label>`).join('');
  return `<div class="spec-row"><input type="text" id="ts-name" value="${esc(src.name)}" placeholder="Name" style="flex:1;font-weight:600"/>
      <button class="btn-primary small" data-action="ts-test" title="Fetch a token now, using ${esc(p ? p.name : 'no project')}'s active environment">Test</button>
      <button class="btn-ghost small" data-action="ts-duplicate">Duplicate</button>
      <button class="btn-ghost small" data-action="ts-delete">Delete</button></div>
    <div class="url-bar" style="padding:0;border:none;margin-bottom:8px">
      <select class="method-select" id="ts-method">${METHODS.map((m) => `<option ${m === src.method ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <input class="url-input" id="ts-url" type="text" spellcheck="false" value="${esc(src.url)}" placeholder="https://… /oauth/token"/></div>
    <h4 class="section-title">Headers</h4>${kvRows(src.headers, 'ts-headers', { keyPh: 'Header', valPh: 'value (may use {{variables}})' })}
    <h4 class="mt-10 section-title">Body</h4><div class="mb-6">${radios}</div>
    ${src.body.type === 'form' ? kvRows(src.body.form, 'ts-form') : src.body.type === 'none' ? '' : `<textarea id="ts-body" rows="4" spellcheck="false" placeholder="grant_type=client_credentials&client_id={{clientId}}&client_secret={{clientSecret}}">${esc(src.body.text)}</textarea>`}
    <div class="mt-10 spec-row"><label class="w-90 hint" for="ts-token-path">Token path</label>
      <input type="text" id="ts-token-path" value="${esc(src.tokenPath)}" placeholder="access_token" spellcheck="false" style="width:220px"/>
      <span class="hint">where the token is in the JSON response (e.g. <code>access_token</code>, <code>data.token</code>)</span></div>
    <p class="mt-8 hint">{{variables}} come from the requesting project's active environment, so one source can serve several environments.
      Tokens are kept in memory only, reused until they expire (<code>expires_in</code> or the JWT's <code>exp</code>), and fetched again after a 401.</p>
    ${test ? (test.error ? `<p class="error-text">✗ ${esc(test.error)}</p>`
      : `<div class="ts-result"><span class="assert-pass">✓ Token received</span> <code>${esc(mask(test.token))}</code>
          <span class="hint">${test.expiresAt ? `expires ${esc(new Date(test.expiresAt).toLocaleString())}` : 'no expiry given'}</span>
          <button class="btn-ghost small" data-action="ts-to-jwt">Inspect in JWT tool</button></div>`)
      : cached ? `<p class="hint">Cached token from ${esc(fmtTime(cached.fetchedAt))} for ${esc(p?.name || '')}${cached.expiresAt ? `, expires ${esc(new Date(cached.expiresAt).toLocaleTimeString())}` : ''}. <button class="link-btn" data-action="ts-forget">Forget</button></p>` : ''}`;
}

export function tokensPageHtml() {
  const src = selectedTokenSource();
  const used = (id) => DB.projects.reduce((n, p) => n + [p.auth, ...p.folders.map((f) => f.auth), ...[...p.requests, ...p.folders.flatMap((f) => f.requests)].map((r) => r.auth)].filter((a) => a?.type === 'token' && a.sourceId === id).length, 0);
  const list = DB.tokenSources.map((t) => `<div class="sidebar-item${t === src ? ' active' : ''}" data-action="ts-open" data-id="${esc(t.id)}">
      <span class="item-name">${esc(t.name)}</span><span class="hint">${used(t.id) || ''}</span></div>`).join('');
  return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button><h3>Token sources</h3></div>
    <p class="mb-10 hint">Requests that fetch an access token. Use one from a request's, folder's or project's Auth → <b>token source</b>.
      Sources are shared by all projects and aren't included in collection exports.</p>
    <div class="row gap-14 items-start">
      <div style="width:210px;flex-shrink:0">${list || '<p class="hint">None yet.</p>'}
        <div style="display:flex;gap:4px;margin:6px 4px"><button class="btn-ghost small" data-action="ts-new">+ New</button>
          <button class="btn-ghost small" data-action="ts-import" title="A bare request object, or any export containing requests (first one is used)">Import from file…</button></div></div>
      <div class="grow min0">${src ? editorHtml(src) : '<p class="hint">Create a token source, or import one from a file.</p>'}</div></div>`;
}
