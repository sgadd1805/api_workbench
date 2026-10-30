// Intercepting proxy page (S.page === 'proxy'): settings, client setup help, the local CA,
// breakpoints with paused requests to edit, and the captured traffic. State: S.proxy (actions/proxy.js).
import { esc } from '../../shared/html.js';
import { S } from '../store.js';
import { viewerHtml } from './viewer.js';
import { codeEditorHtml } from '../editor.js';
import { icon } from '../../shared/icons.js';

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtSize = (n) => (n == null ? '' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const headerText = (h) => Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join('\n');

// Setting an environment variable for the next command, in this computer's shells.
const IS_WINDOWS = /^Win/i.test(globalThis.navigator?.platform || '');
function envRows(row, label, vars) {
  if (!IS_WINDOWS) return row(label, `export ${vars.map(([k, v]) => `${k}=${/\s/.test(v) ? `"${v}"` : v}`).join(' ')}`);
  return row(`${label} (cmd)`, vars.map(([k, v]) => `set "${k}=${v}"`).join(' & '))
    + row(`${label} (PowerShell)`, vars.map(([k, v]) => `$env:${k}="${v}"`).join('; '));
}

function setupHtml(P) {
  const addr = `http://127.0.0.1:${P.port || 8899}`;
  const ca = P.ca;
  const row = (label, cmd) => `<tr><td class="hint">${label}</td><td><code>${esc(cmd)}</code></td><td><button class="btn-ghost small" data-action="copy-text" data-text="${esc(cmd)}">Copy</button></td></tr>`;
  return `<details class="proxy-setup"${P.running ? '' : ' open'}><summary class="hint">Point an app at the proxy</summary>
    <table class="proxy-cmds">
      ${envRows(row, 'curl / most CLIs', [['HTTP_PROXY', addr], ['HTTPS_PROXY', addr]])}
      ${row('Java (JVM flags)', `-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=${P.port || 8899} -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=${P.port || 8899} -Dhttp.nonProxyHosts=`)}
      ${ca ? row('Java: trust the CA', `keytool -importcert -noprompt -alias api-workbench-proxy -file "${ca.certFile}" -keystore proxy-truststore.p12 -storepass changeit`) + row('… then run with', '-Djavax.net.ssl.trustStore=proxy-truststore.p12 -Djavax.net.ssl.trustStorePassword=changeit') : ''}
      ${ca ? envRows(row, 'Node.js: trust the CA', [['NODE_EXTRA_CA_CERTS', ca.certFile]]) : ''}
      ${ca && IS_WINDOWS ? row('Windows: trust the CA (browsers, .NET)', `certutil -user -addstore Root "${ca.certFile}"`) : ''}
      ${row('Browser', 'Chrome: --proxy-server=' + addr)}
    </table>
    <p class="hint">Phones and other machines: turn on "Allow other devices", set the Wi-Fi proxy to this computer's address, and open <code>http://&lt;address&gt;:${P.port || 8899}/ca.crt</code> on the device to install the CA.</p>
    <h4 class="section-title">Local CA (for decrypting HTTPS)</h4>
    ${ca ? `<p class="hint">${esc(ca.subject)} · SHA-256 <code class="fingerprint">${esc(ca.fingerprint256)}</code> · valid until ${esc(ca.validTo)}</p>` : '<p class="hint">Created the first time you decrypt HTTPS (or now, with Export).</p>'}
    <p class="hint">Clients only accept decrypted traffic if they trust this certificate. Trust it only on machines and apps you are debugging,
      and remove it when done. Its private key never leaves this computer (stored in a file only your user account can read).</p>
    <div class="spec-row"><button class="btn-ghost small" data-action="proxy-ca-export">Export CA certificate…</button>
      <button class="btn-ghost small" data-action="proxy-ca-open" title="Opens the certificate with the system (macOS: Keychain Access; Windows: certificate import)">Open with system…</button>
      ${ca ? '<button class="btn-ghost small" data-action="proxy-ca-regenerate" title="New CA; certificates trusted before stop working">Regenerate</button>' : ''}</div></details>`;
}

export const pausedTitle = (n) => (n ? `${icon('pause')} Paused at a breakpoint (${n})` : '');

export function pausedCardHtml(p) {
  return `<div class="paused-card" data-id="${esc(p.id)}">
      <div class="spec-row"><select class="pz-method">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => `<option ${m === p.method ? 'selected' : ''}>${m}</option>`).join('')}</select>
        <input type="text" class="pz-url" value="${esc(p.url)}" spellcheck="false"/></div>
      <label class="hint">Headers (one per line)</label><textarea class="pz-headers" rows="4" spellcheck="false">${esc(headerText(p.headers))}</textarea>
      ${p.body == null ? '<p class="hint">Binary body (forwarded unchanged).</p>' : `<label class="hint">Body</label>${codeEditorHtml({ id: `pz-body-${p.id}`, value: p.body, lang: /^\s*[[{]/.test(p.body) ? 'json' : 'text', rows: 5 })}`}
      <div class="mt-6 spec-row"><button class="btn-primary small" data-action="proxy-forward" data-id="${esc(p.id)}">Forward</button>
        <button class="btn-ghost small" data-action="proxy-forward" data-id="${esc(p.id)}" data-original="1" title="Forward without your edits">Forward unchanged</button>
        <button class="btn-ghost small danger-text" data-action="proxy-drop" data-id="${esc(p.id)}">Drop</button>
        <span class="hint">${fmtTime(p.at)}</span></div></div>`;
}

export const visibleExchanges = (P) => {
  const q = P.filter.trim().toLowerCase();
  return q ? P.exchanges.filter((x) => `${x.method} ${x.url} ${x.status ?? ''} ${x.error ?? ''}`.toLowerCase().includes(q)) : P.exchanges;
};

export function detailHtml(x) {
  if (!x) return '';
  const res = x.error ? null : { status: x.status, statusText: x.statusText, headers: x.responseHeaders, ...x.response, time: x.time };
  return `<div class="proxy-detail">
    <div class="spec-row"><b>${esc(x.method)}</b> <code class="proxy-url">${esc(x.url)}</code><span class="spacer"></span>
      <button class="btn-ghost small" data-action="proxy-save" title="Add to the current project as a request">Save as request</button>
      <button class="btn-ghost small" data-action="proxy-curl">Copy as cURL</button></div>
    ${x.edited ? '<p class="warn-text">Edited at a breakpoint before forwarding.</p>' : ''}
    <h4 class="section-title">Request</h4><pre class="resp-body">${esc(headerText(x.requestHeaders))}${x.request?.body ? '\n\n' + esc(x.request.body) : ''}</pre>
    <h4 class="section-title">Response ${res ? `<span class="${res.status < 400 ? 'status-ok' : 'status-err'}">${res.status} ${esc(res.statusText || '')}</span> <span class="hint">${x.time} ms</span>` : ''}</h4>
    ${x.error ? `<p class="error-text">${esc(x.error)}</p>` : `<details><summary class="hint">Headers</summary><pre class="resp-body">${esc(headerText(x.responseHeaders))}</pre></details>
      ${x.tunnel ? '<p class="hint">HTTPS tunnel passed through without decrypting (turn on "Decrypt HTTPS" to see inside).</p>' : viewerHtml(res, 'proxy')}`}</div>`;
}

export function trafficHtml(P) {
  const rows = visibleExchanges(P).slice(0, 500).map((x) => {
    let host = '', path = x.url;
    try { const u = new URL(x.url); host = u.host; path = u.pathname + u.search; } catch { /* keep raw */ }
    const status = x.error ? `<span class="status-err" title="${esc(x.error)}">ERR</span>` : `<span class="${x.status < 400 ? 'status-ok' : 'status-err'}">${x.status}</span>`;
    return `<tr class="proxy-row${x.id === P.selected ? ' active' : ''}" data-action="proxy-select" data-id="${esc(x.id)}">
      <td class="hint">${fmtTime(x.at)}</td><td><b>${esc(x.method)}</b></td><td>${status}</td><td class="proxy-host">${esc(host)}</td>
      <td class="proxy-path" title="${esc(x.url)}">${esc(path)}${x.edited ? ' ✎' : ''}${x.tunnel ? ' <span class="hint">(tunnel)</span>' : ''}</td><td class="hint">${fmtSize(x.response?.size)}</td><td class="hint">${x.time ?? ''}${x.time != null ? ' ms' : ''}</td></tr>`;
  }).join('');
  return rows ? `<div class="proxy-table-wrap"><table class="run-table proxy-table"><tr><th>Time</th><th></th><th>Status</th><th>Host</th><th>Path</th><th>Size</th><th>Time</th></tr>${rows}</table></div>`
    : `<p class="hint">${P.exchanges.length ? 'Nothing matches the filter.' : P.running ? 'Waiting for traffic…' : 'Start the proxy, then point an app at it.'}</p>`;
}

// Mock servers made from recorded traffic (actions/proxy.js proxy-mock-new).
function recordedMocksHtml(P) {
  const mocks = Object.entries(P.mocks || {});
  if (!mocks.length) return '';
  return mocks.map(([id, m]) => `<section class="rec-mock"><div class="spec-row"><b>Mock of ${esc(m.host)}</b>
      <code>${esc(m.url)}</code><button class="btn-ghost small" data-action="copy-text" data-text="${esc(m.url)}">Copy URL</button>
      <span class="hint" id="rec-hits-${esc(id)}">${m.hits} request${m.hits === 1 ? '' : 's'} served</span><span class="grow"></span>
      <button class="btn-ghost small" data-action="proxy-mock-stop" data-id="${esc(id)}">${icon('stop')} Stop</button></div>
    <p class="hint">Point the app that calls ${esc(m.host)} at this address instead. Each route answers with its latest recorded response; pick another recorded status per route, or force one per call with <code>X-Mock-Status</code>.</p>
    <table class="run-table rec-table"><tr><th>Route</th><th>Recorded</th><th>Responds with</th></tr>${m.routes.map((r, i) => `<tr><td><b>${esc(r.method)}</b> <code>${esc(r.path)}</code></td><td class="hint">${r.count}×</td>
      <td><select class="rec-ov" data-mock="${esc(id)}" data-route="${i}">${Object.keys(r.responses).map((c) => `<option value="${c}" ${(r.override || r.defaultCode) === c ? 'selected' : ''}>${c}${c === r.defaultCode ? ' (latest)' : ''}</option>`).join('')}
        ${['404', '500', '503'].filter((c) => !r.responses[c]).map((c) => `<option value="${c}" ${r.override === c ? 'selected' : ''}>${c} (generic)</option>`).join('')}
        <option value="drop" ${r.override === 'drop' ? 'selected' : ''}>drop connection</option></select></td></tr>`).join('')}</table></section>`).join('');
}

export function proxyPageHtml() {
  const P = S.proxy;
  const sel = P.exchanges.find((x) => x.id === P.selected);
  return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button><h3>Intercepting proxy</h3></div>
    <div class="spec-row proxy-controls">
      <label class="hint" for="proxy-port">Port</label><input type="text" id="proxy-port" value="${esc(P.port || 8899)}" class="w-64" ${P.running ? 'disabled' : ''}/>
      <label><input type="checkbox" id="proxy-decrypt" ${P.decryptHttps ? 'checked' : ''} ${P.running ? 'disabled' : ''}/> Decrypt HTTPS</label>
      <label title="Listen on all network interfaces so phones / other machines can use it. Anyone on the same network can then use the proxy: it has no password."><input type="checkbox" id="proxy-lan" ${P.allowLan ? 'checked' : ''} ${P.running ? 'disabled' : ''}/> Allow other devices</label>
      <label><input type="checkbox" id="proxy-insecure" ${P.insecureUpstream ? 'checked' : ''}/> Ignore upstream certificate errors</label>
      <label><input type="checkbox" id="proxy-history" ${P.toHistory ? 'checked' : ''}/> Add to History</label>
      ${P.running ? '<button class="btn-primary danger small" data-action="proxy-stop">' + icon('stop') + ' Stop</button>' : '<button class="btn-primary small" data-action="proxy-start">' + icon('play') + ' Start</button>'}</div>
    ${P.allowLan ? `<p class="warn-text proxy-lan-warning">⚠ With "Allow other devices", anyone on the same network (office or café Wi-Fi) can use this proxy: it has no password,
      can reach services that only listen on this computer (localhost), and${P.toHistory ? ' their traffic lands in your History.' : ' sees what you capture.'} Turn it on only on a network you trust, and off when you're done.</p>` : ''}
    ${P.running ? `<p class="hint">Listening on <code>127.0.0.1:${P.port}</code>${P.lan.length ? ` and ${P.lan.map((a) => `<code>${esc(a)}:${P.port}</code>`).join(', ')} <span class="warn-text">(reachable from your network)</span>` : ''}.</p>` : ''}
    ${setupHtml(P)}
    <h4 class="section-title">Breakpoints</h4>
    <textarea id="proxy-breakpoints" rows="2" spellcheck="false" placeholder="One per line: a URL fragment (/api/orders) or METHOD + fragment (POST /api/orders). Matching requests pause here.">${esc(P.breakpoints)}</textarea>
    <section id="proxy-paused" class="proxy-paused"><h4 class="section-title" id="proxy-paused-title">${pausedTitle(P.paused.length)}</h4>${P.paused.map(pausedCardHtml).join('')}</section>
    <h4 class="section-title">Traffic <span class="hint" id="proxy-count">${P.exchanges.length}</span></h4>
    <div class="spec-row"><input type="text" id="proxy-filter" value="${esc(P.filter)}" placeholder="Filter: host, path, method, status" spellcheck="false" class="grow"/>
      <button class="btn-ghost small" data-action="proxy-mock-new" title="Serve one host's recorded responses from a local mock server">Mock from traffic…</button>
      <button class="btn-ghost small" data-action="proxy-clear">Clear</button></div>
    ${recordedMocksHtml(P)}
    <div id="proxy-traffic">${trafficHtml(P)}</div>
    <div id="proxy-detail">${detailHtml(sel)}</div>`;
}
