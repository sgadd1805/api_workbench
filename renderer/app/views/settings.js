// App settings page (top bar ⚙): appearance, layout, and what AI assistance may send.
import { esc } from '../../shared/html.js';
import { DB, S } from '../store.js';
import { setupSnippets } from '../actions/mcp.js';
import { icon } from '../../shared/icons.js';

// Prompt sections (DB.settings.aiPrompt), by button.
export const AI_SECTIONS = [
  ['“Why did this fail?” / “Ask Claude”', [
    ['request', 'Request line and headers'], ['requestBody', 'Request body'], ['response', 'Response status and headers'], ['responseBody', 'Response body'],
    ['spec', 'Spec check'], ['warnings', 'Client warnings'], ['timing', 'Timing'], ['logs', 'Server log lines'],
    ['lastGood', 'Last successful response'], ['commits', 'Recent commits'], ['commitAuthors', 'Commit author names'],
  ]],
  ['“Investigate” (login page)', [['page', 'Page HTML'], ['console', 'Console logs'], ['network', 'Network calls'], ['networkBodies', 'Network response bodies']]],
];

function aiPromptHtml(p) {
  const box = ([key, label]) => `<label class="mr-12"><input type="checkbox" data-ai-section="${key}" ${p[key] !== false ? 'checked' : ''}/> ${label}</label>`;
  return `${AI_SECTIONS.map(([title, items]) => `<div class="spec-row items-start"><span class="w-110 hint">${title}</span><span class="row wrap grow gap-6">${items.map(box).join('')}</span></div>`).join('')}
      <div class="spec-row items-start"><span class="w-110 hint">Extra instructions</span>
        <textarea id="set-ai-instructions" class="grow" rows="3" spellcheck="true" placeholder="Added to every prompt, e.g. “The service is Spring Boot 3 on Java 21. Keep the answer short.”">${esc(p.instructions || '')}</textarea></div>
      <p class="hint">Passwords, tokens, API keys and cookies are always removed before anything is sent: credential headers,
        secret-looking fields in URLs, bodies, logs and page HTML (password, token, api_key, secret …), bearer tokens, JWTs,
        private keys and well-known API key formats, and every value saved in the app as a secret (auth, secret variables,
        test-account passwords, cached tokens).</p>`;
}

// Encrypting secrets on disk (main/vault.js); S.secretsStatus comes from the main process.
function encryptionHtml(s) {
  const st = S.secretsStatus, on = s.encryptSecrets !== false;
  const state = !st ? '' : st.active ? `<span class="assert-pass">Encrypted with ${esc(st.backend)}.</span>`
    : !st.available ? `<span class="warn-text">This computer offers no secret protection${st.backend === 'basic_text' ? ' (no keyring is running)' : ''}, so secrets are stored as plain text.</span>`
    : '<span class="warn-text">Stored as plain text.</span>';
  return `<div class="spec-row"><span class="w-110 hint">Secrets on disk</span><label><input type="checkbox" id="set-encrypt" ${on ? 'checked' : ''}/> Encrypt secrets with ${/^Win/.test(navigator.platform) ? 'Windows protection (DPAPI)' : /^Mac/.test(navigator.platform) ? 'the macOS Keychain' : 'the system keyring'}</label></div>
      <p class="hint">${state} Tokens, passwords, secret variables, cookies, certificate passphrases, test-account passwords and the proxy's
        CA key are encrypted for your user account on this computer. Encrypted data can't be read on another computer or by another user,
        so copying the data folder won't carry secrets: use <b>Back up everything</b> with secrets to move them. The command-line runner
        can't read encrypted secrets either; give it the ones a run needs with <code>--var</code> or <code>AW_VAR_&lt;name&gt;</code>.</p>`;
}

// Settings → MCP server (actions/mcp.js).
function mcpHtml(s) {
  const m = s.mcp || {}, st = S.mcp;
  const on = !!m.enabled && st?.running;
  const snip = setupSnippets(m, st?.port || m.port);
  const copyRow = (what, label, text) => `<div class="mcp-snippet"><div class="row items-center gap-6"><span class="hint">${label}</span><span class="grow"></span>
      <button class="btn-ghost small" data-action="mcp-copy" data-what="${what}">Copy</button></div><pre>${esc(text)}</pre></div>`;
  return `<h4 class="section-title">MCP server</h4>
    <div class="spec-row"><span class="w-110 hint">Server</span><label><input type="checkbox" id="set-mcp" ${m.enabled ? 'checked' : ''}/> Let MCP clients (Claude Code, Claude Desktop …) use API Workbench</label></div>
    <p class="hint">${on ? `<span class="assert-pass">Running at <code>${esc(st.url)}</code>.</span>${st.lastActivity ? ` Last used ${esc(new Date(st.lastActivity.at).toLocaleTimeString())}.` : ''}` : m.enabled && st && !st.running ? '<span class="warn-text">Not running.</span>' : 'Off.'}
      Clients can list and read your requests, send them (as you would, with your auth), run collections, and read History, specs and logs. Only this computer
      can connect (127.0.0.1), and only with the token.</p>
    ${m.enabled ? `<div class="spec-row"><span class="w-110 hint">Port</span><input type="text" id="set-mcp-port" class="w-70" value="${esc(m.port || 3920)}"/>
        <label class="ml-12"><input type="checkbox" id="set-mcp-redact" ${m.redact !== false ? 'checked' : ''}/> Hide credentials from clients</label>
        <label class="ml-12"><input type="checkbox" id="set-mcp-edits" ${m.allowEdits ? 'checked' : ''}/> Allow changes (save requests)</label></div>
      <div class="spec-row"><span class="w-110 hint">Token</span><code class="mcp-token">${esc((m.token || '').slice(0, 6))}••••••••••••</code>
        <button class="btn-ghost small" data-action="mcp-copy-token">Copy</button><button class="btn-ghost small" data-action="mcp-new-token">New token</button></div>
      ${copyRow('claudeCode', 'Claude Code: run this in a terminal', snip.claudeCode.replace(m.token, (m.token || '').slice(0, 6) + '…'))}
      ${copyRow('claudeDesktop', 'Claude Desktop: add to claude_desktop_config.json (Settings → Developer → Edit Config); it reads the token itself while the app runs', snip.claudeDesktop)}
      <p class="hint">Copy puts the full command, token included, on the clipboard. Treat the token like a password: anyone with it can send requests as you while the app runs.</p>` : ''}`;
}

const radio = (name, value, current, label) => `<label class="mr-12"><input type="radio" name="${name}" value="${esc(value)}" ${value === current ? 'checked' : ''}/> ${label}</label>`;

export function settingsPageHtml() {
  const s = DB.settings, l = s.layout;
  return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button><h3>Settings</h3></div>
    <div class="settings-grid">
      <h4 class="section-title">Appearance</h4>
      <div class="spec-row"><span class="w-110 hint">Theme</span>${radio('set-theme', 'system', s.theme, 'System')}${radio('set-theme', 'dark', s.theme, 'Dark')}${radio('set-theme', 'light', s.theme, 'Light')}</div>
      <div class="spec-row"><span class="w-110 hint">Zoom</span>
        <input type="range" id="set-zoom" min="0.7" max="1.6" step="0.05" value="${s.zoom}" style="width:200px"/> <span id="set-zoom-label">${Math.round(s.zoom * 100)}%</span>
        <button class="btn-ghost small" data-action="zoom-reset">Reset</button></div>
      <h4 class="section-title">Layout</h4>
      <div class="spec-row"><span class="w-110 hint">Request / response</span>${radio('set-split', 'row', l.split, 'Side by side')}${radio('set-split', 'column', l.split, 'Stacked')}</div>
      <div class="spec-row"><span class="w-110 hint">Panels</span>
        <label class="mr-12"><input type="checkbox" id="set-side" ${l.sideOpen ? 'checked' : ''}/> Side panel (Spec / Git / Tools)</label>
        <label><input type="checkbox" id="set-session" ${l.session ? 'checked' : ''}/> Session toolbar (Login / Creds / Capture)</label></div>
      <h4 class="section-title">Privacy</h4>
      ${encryptionHtml(s)}
      <div class="spec-row"><span class="w-110 hint">AI assistance</span><label><input type="checkbox" id="set-ai" ${s.ai ? 'checked' : ''}/> “Why did this fail?”, “Ask Claude” and “Investigate”</label></div>
      <p class="hint">Off by default. When on, those buttons send the request, response, matching log lines, recent commit messages
        or the login page to Anthropic through your own <code>claude</code> command-line tool, with credentials removed.
        Nothing else in the app contacts any service you haven't pointed it at, and there is no telemetry.</p>
      ${s.ai ? `<h4 class="section-title">What Claude is sent</h4>${aiPromptHtml(s.aiPrompt || {})}` : ''}
      ${mcpHtml(s)}
    </div>`;
}
