import { varHistory } from '../varlog.js';
import { esc } from '../../shared/html.js';
import { S, currentProject } from '../store.js';
import { kvRows } from './kv.js';
import { icon } from '../../shared/icons.js';

// The environment open on the envs page: S.envId, else the active one, else the first.
export function selectedEnv(p) {
  return p?.envs.find((e) => e.id === S.envId) || p?.envs.find((e) => e.id === p.activeEnv) || p?.envs[0] || null;
}

// TLS / client certificate / proxy / HTTP/2 for requests sent while this environment is active.
function networkHtml(n) {
  const file = (field, label, ph) => `<div class="spec-row"><label class="hint net-label" for="net-${field}">${label}</label>
    <input type="text" id="net-${field}" value="${esc(n[field])}" placeholder="${esc(ph)}" spellcheck="false" class="grow"/>
    <button class="btn-ghost small" data-action="net-browse" data-field="${field}">Browse…</button></div>`;
  const anyTls = n.caFile || n.insecure || n.certFile || n.pfxFile;
  return `<details class="net-settings"${anyTls || n.proxy || n.http2 ? ' open' : ''}><summary class="section-title" style="cursor:pointer;margin-top:14px">Network: certificates, proxy, HTTP/2</summary>
    ${file('caFile', 'Trusted CA', 'PEM file of a company or self-signed CA (added to the system CAs)')}
    <div class="spec-row"><span class="net-label"></span><label><input type="checkbox" id="net-insecure" ${n.insecure ? 'checked' : ''}/> Ignore certificate errors</label>
      ${n.insecure ? '<span class="warn-text">⚠ any certificate is accepted — use only for local/test servers</span>' : ''}</div>
    ${file('certFile', 'Client cert', 'PEM certificate (mutual TLS)')}
    ${file('keyFile', 'Client key', 'PEM private key')}
    ${file('pfxFile', 'or PFX / P12', 'PKCS#12 bundle instead of cert + key')}
    <div class="spec-row"><label class="hint net-label" for="net-passphrase">Passphrase</label><input type="password" id="net-passphrase" value="${esc(n.passphrase)}" placeholder="for the key / PFX, if any" autocomplete="new-password" style="width:240px"/></div>
    <div class="spec-row"><label class="hint net-label" for="net-proxy">Proxy</label><input type="text" id="net-proxy" value="${esc(n.proxy)}" placeholder="http://[user:pass@]proxy.host:8080" spellcheck="false" class="grow"/></div>
    <div class="spec-row"><span class="net-label"></span><label><input type="checkbox" id="net-http2" ${n.http2 ? 'checked' : ''}/> Use HTTP/2 for https URLs</label></div>
  </details>`;
}

// Variable history (varlog.js): when, which variable, old → new value, and what set it.
export function varChangesHtml(list, { showEnv = false } = {}) {
  if (!list.length) return showEnv ? '<p class="hint">No variable changes recorded yet.</p>' : '';
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t).toLocaleString(); };
  return `${showEnv ? '' : '<h4 class="mt-14 section-title">Recent changes</h4>'}<table class="diff-fields var-history">
    ${list.map((e) => `<tr><td class="hint" title="${esc(new Date(e.at).toLocaleString())}">${esc(ago(e.at))}</td>${showEnv ? `<td class="hint">${esc(e.projectName)} · ${esc(e.envName)}</td>` : ''}
      <td><code>{{${esc(e.name)}}}</code></td><td class="diff-del">${esc(e.before)}</td><td class="diff-add">${esc(e.value)}</td><td class="hint">${esc(e.source)}</td></tr>`).join('')}</table>`;
}

export function envsPageHtml() {
  const p = currentProject();
  if (!p) return '<p class="hint">Select a project first.</p>';
  const env = selectedEnv(p);
  const list = p.envs.map((e) => `<div class="sidebar-item${e === env ? ' active' : ''}" data-action="env-open" data-id="${esc(e.id)}">
      <span class="item-name">${esc(e.name)}</span>${e.id === p.activeEnv ? '<span class="hint">active</span>' : ''}</div>`).join('');
  const editor = env ? `<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
        <input type="text" id="env-name" value="${esc(env.name)}" class="grow" placeholder="Environment name"/>
        ${env.id === p.activeEnv ? '<span class="hint">Active</span>' : `<button class="btn-ghost small" data-action="env-activate" data-id="${esc(env.id)}">Make active</button>`}
        <button class="btn-ghost small" data-action="env-duplicate" data-id="${esc(env.id)}">Duplicate</button>
        <button class="btn-ghost small" data-action="env-delete" data-id="${esc(env.id)}">Delete</button></div>
      ${kvRows(env.vars, 'vars', { keyPh: 'name', valPh: 'value', secretToggle: true })}
      ${varChangesHtml(varHistory({ envId: env.id }).slice(0, 30))}
      <h4 class="mt-14 section-title">Login URLs</h4>
      <p class="mb-6 hint">Offered in the Session toolbar's Login picker while this environment is active. Test accounts whose
        <i>env</i> matches this environment's name are the ones shown under Creds.</p>
      ${kvRows(env.loginUrls, 'login-urls', { keyPh: 'label, e.g. SSO', valPh: 'https://… login page' })}
      ${networkHtml(env.network)}`
    : '<p class="hint">No environments yet.</p>';
  return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button>
      <h3>Environments: ${esc(p.name)}</h3></div>
    <p class="mb-10 hint">Use <code>{{name}}</code> in URLs, headers, bodies and auth. Values come from the active environment; switch it from the top bar.</p>
    <div class="row gap-14 items-start">
      <div style="width:200px;flex-shrink:0">${list}<button class="btn-ghost small" style="margin:6px 4px" data-action="env-add">+ Environment</button></div>
      <div class="grow min0">${editor}</div></div>`;
}
