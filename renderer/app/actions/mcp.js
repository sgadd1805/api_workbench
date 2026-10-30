// Settings → MCP server: switching it on and off, its port, token and options, and the setup to paste into
// Claude Code / Claude Desktop (main/mcp.js runs the server; renderer/app/mcp.js answers its tools).
import { copyText } from '../../shared/html.js';
import { notify } from '../../shared/notify.js';
import { DB, S, saveDB } from '../store.js';
import { renderPage } from '../views/index.js';

const api = () => window.electronAPI;
export const MCP_DEFAULT_PORT = 3920;
const M = () => (DB.settings.mcp ||= { enabled: false, port: MCP_DEFAULT_PORT, token: '', allowEdits: false, redact: true });
const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');

// The app's folder, for the stdio bridge's path in Claude Desktop's config.
export function appFolder() {
  try { const p = decodeURIComponent(new URL('.', location.href).pathname); return /^\/[A-Za-z]:\//.test(p) ? p.slice(1).replace(/\//g, '\\').replace(/\\$/, '') : p.replace(/\/$/, ''); } catch { return '<API Workbench folder>'; }
}
const bridgePath = () => { const f = appFolder(); return f.includes('\\') ? `${f}\\bin\\api-workbench-mcp.js` : `${f}/bin/api-workbench-mcp.js`; };

// What to paste: Claude Code over HTTP (with the token), Claude Desktop through the stdio bridge (it reads the token itself).
export function setupSnippets(m = M(), port = S.mcp?.port || m.port || MCP_DEFAULT_PORT) {
  const url = `http://127.0.0.1:${port}/mcp`;
  return {
    claudeCode: `claude mcp add --transport http api-workbench ${url} --header "Authorization: Bearer ${m.token}"`,
    claudeDesktop: JSON.stringify({ mcpServers: { 'api-workbench': { command: 'node', args: [bridgePath()] } } }, null, 2),
    http: `${url}  (header Authorization: Bearer ${m.token})`,
  };
}

async function start() {
  const m = M();
  if (!m.token) m.token = newToken();
  const res = await api().mcpStart({ port: Number(m.port) || MCP_DEFAULT_PORT, token: m.token, allowEdits: !!m.allowEdits });
  S.mcp = res;
  if (!res.ok) { m.enabled = false; notify(`MCP server: ${res.error}`, 'error', 8000); } else notify(`MCP server on at ${res.url}`, 'info', 5000);
  saveDB(); if (S.page === 'settings') renderPage();
}
async function stop() { S.mcp = await api().mcpStop(); if (S.page === 'settings') renderPage(); }

export async function setMcpEnabled(on) { M().enabled = !!on; saveDB(); if (on) await start(); else await stop(); }

export function onMcpSettingChange(el) {
  const m = M();
  switch (el.id) {
    case 'set-mcp': setMcpEnabled(el.checked); return true;
    case 'set-mcp-port': { const port = parseInt(el.value, 10); if (!(port > 0 && port < 65536)) { notify('Port must be 1–65535', 'error'); return true; } m.port = port; saveDB(); if (m.enabled) start(); return true; }
    case 'set-mcp-edits': m.allowEdits = el.checked; saveDB(); api().mcpAllowEdits(el.checked).then((r) => { S.mcp = { ...S.mcp, ...r }; }); return true;
    case 'set-mcp-redact': m.redact = el.checked; saveDB(); if (!el.checked) notify('MCP clients will now see tokens, passwords and keys in requests and responses', 'error', 8000); return true;
    default: return false;
  }
}

export const mcpActions = {
  'mcp-copy'(d, el) { copyText(setupSnippets()[d.what] || ''); notify('Copied'); el?.blur?.(); },
  'mcp-copy-token'() { copyText(M().token); notify('Token copied'); },
  async 'mcp-new-token'() {
    M().token = newToken(); saveDB();
    if (M().enabled) await start();
    notify('New token: clients set up with the old one need the new setup', 'info', 7000);
    renderPage();
  },
};
