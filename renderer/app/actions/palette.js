// Every setting and page in the ⌘K palette (actions/search.js), so the app can be driven from the keyboard.
// Items: { kind: 'setting' | 'page', group, title, state?, keywords, run, keepOpen? }
//   state: what the setting is now ('on' / 'off', '120%', 'current') — shown at the right
//   keepOpen: toggles leave the palette open and refresh, so several can be flipped in a row
import { DB, S, saveDB, currentProject, findReq, AI_PROMPT_DEFAULTS, LAYOUT_DEFAULTS } from '../store.js';
import { renderAll } from '../views/index.js';
import { AI_SECTIONS } from '../views/settings.js';
import { applyAppearance, applyAiSetting, openSide, sendToTool, setEncryption } from './layout.js';
import { setPage } from './core.js';
import { startReceiver, stopReceiver } from './otel.js';
import { setProxyOption, proxyOptions } from './proxy.js';
import { watchOf } from './logwatch.js';
import { openAccounts } from './accounts.js';
import { setMcpEnabled } from './mcp.js';
import { openModal } from '../modal.js';
import { varHistory } from '../varlog.js';
import { varChangesHtml } from '../views/envs.js';

const onOff = (v) => (v ? 'on' : 'off');
const TOOLS = [['jwt', 'JWT'], ['url', 'URL'], ['base64', 'Base64'], ['json', 'JSON'], ['diff', 'Diff'], ['hash', 'Hash'], ['timestamp', 'Timestamp'], ['regex', 'Regex'], ['xml', 'XML'], ['string', 'String']];

// actions: the full action table (actions/index.js), for pages that open through an action.
// render: redraws the app after a setting changes.
export function settingItems(actions, { render = renderAll } = {}) {
  const items = [];
  const s = DB.settings, L = () => (s.layout ||= { ...LAYOUT_DEFAULTS });
  const act = (name, d = {}) => () => actions[name]?.(d, document.body, { target: document.body });
  const save = (fn) => () => { fn(); saveDB(); render(); };
  const toggle = (group, title, get, set, keywords = '') => items.push({ kind: 'setting', group, title, state: onOff(get()), keywords, keepOpen: true, run: save(() => set(!get())) });
  const choice = (group, title, current, run, keywords = '') => items.push({ kind: 'setting', group, title, state: current ? 'current' : '', keywords, keepOpen: true, run: save(run) });
  const page = (title, run, keywords = '', group = 'Go to') => items.push({ kind: 'page', group, title, keywords, run });

  // ---- Appearance and layout
  for (const [v, label] of [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']]) choice('Appearance', `Theme: ${label}`, s.theme === v, () => { s.theme = v; applyAppearance(); }, 'colour color mode');
  const zoom = (z) => { s.zoom = Math.round(Math.min(1.6, Math.max(0.7, z)) * 100) / 100; applyAppearance(); };
  items.push({ kind: 'setting', group: 'Appearance', title: 'Zoom in', state: `${Math.round(s.zoom * 100)}%`, keywords: 'bigger larger font size scale', keepOpen: true, run: save(() => zoom(s.zoom + 0.1)) });
  items.push({ kind: 'setting', group: 'Appearance', title: 'Zoom out', state: `${Math.round(s.zoom * 100)}%`, keywords: 'smaller font size scale', keepOpen: true, run: save(() => zoom(s.zoom - 0.1)) });
  items.push({ kind: 'setting', group: 'Appearance', title: 'Reset zoom', state: `${Math.round(s.zoom * 100)}%`, keywords: 'font size scale 100', keepOpen: true, run: save(() => zoom(1)) });
  choice('Layout', 'Request and response side by side', L().split === 'row', () => { L().split = 'row'; }, 'split horizontal columns');
  choice('Layout', 'Request above response (stacked)', L().split === 'column', () => { L().split = 'column'; }, 'split vertical rows');
  toggle('Layout', 'Side panel', () => L().sideOpen, (v) => { L().sideOpen = v; }, 'spec git notes tools right');
  toggle('Layout', 'Session toolbar', () => L().session, (v) => { L().session = v; }, 'login creds capture accounts');
  toggle('Editor', 'Wrap long lines in editors', () => !!s.editorWrap, (v) => { s.editorWrap = v; }, 'word wrap code body');

  // ---- Privacy and AI
  items.push({ kind: 'setting', group: 'Privacy', title: 'Encrypt secrets on this computer', state: onOff(s.encryptSecrets !== false), keywords: 'keychain dpapi credential security passwords tokens', keepOpen: true, run: () => setEncryption(s.encryptSecrets === false) });
  items.push({ kind: 'setting', group: 'MCP', title: 'MCP server (let Claude Code / Claude Desktop use the app)', state: onOff(!!s.mcp?.enabled), keywords: 'mcp model context protocol claude agent ai server', keepOpen: true, run: () => setMcpEnabled(!s.mcp?.enabled) });
  toggle('Privacy', 'AI assistance (Ask Claude, Investigate)', () => !!s.ai, (v) => { s.ai = v; applyAiSetting(); }, 'claude anthropic why did this fail');
  const prompt = (s.aiPrompt ||= { ...AI_PROMPT_DEFAULTS });
  for (const [, sections] of AI_SECTIONS) for (const [key, label] of sections) {
    toggle('AI prompt', `Send to Claude: ${label}`, () => prompt[key] !== false, (v) => { prompt[key] = v; applyAiSetting(); }, 'ai claude prompt include privacy');
  }
  page('Edit extra instructions for Claude…', () => { setPage('settings'); setTimeout(() => document.getElementById('set-ai-instructions')?.focus(), 0); }, 'ai claude prompt instructions', 'AI prompt');

  // ---- Trace receiver and proxy
  const otel = (s.otel ||= { autoStart: false, httpPort: 4318, grpcPort: 4317 });
  items.push({ kind: 'setting', group: 'Traces', title: S.otel?.running ? 'Stop the trace receiver' : 'Start the trace receiver', state: S.otel?.running ? `on :${S.otel.ports.http}` : 'off', keywords: 'opentelemetry otel otlp spans', keepOpen: true, run: () => (S.otel?.running ? stopReceiver() : startReceiver()) });
  toggle('Traces', 'Start the trace receiver with the app', () => !!otel.autoStart, (v) => { otel.autoStart = v; }, 'opentelemetry otel auto');
  const px = proxyOptions();
  items.push({ kind: 'setting', group: 'Proxy', title: px.running ? 'Stop the intercepting proxy' : 'Start the intercepting proxy', state: px.running ? `on :${px.port}` : 'off', keywords: 'capture traffic mitm', keepOpen: true, run: () => actions[px.running ? 'proxy-stop' : 'proxy-start']?.() });
  for (const [key, label, kw] of [['decryptHttps', 'Proxy: decrypt HTTPS', 'tls ssl ca mitm'], ['toHistory', 'Proxy: add captured traffic to History', ''], ['insecureUpstream', 'Proxy: don\'t verify upstream certificates', 'tls ssl insecure'], ['allowLan', 'Proxy: allow other devices (phones, other computers)', 'lan network wifi mobile']]) {
    toggle('Proxy', label, () => !!px[key], (v) => setProxyOption(key, v), `proxy ${kw}`);
  }

  // ---- The selected project, its environment and the open request
  const p = currentProject();
  if (p) {
    toggle('Project', `${p.name}: correlation headers (X-Request-Id, traceparent)`, () => p.correlation !== false, (v) => { p.correlation = v; }, 'logs trace request id');
    const w = watchOf(p);
    toggle('Log watch', `${p.name}: flag ERROR / FATAL log lines`, () => w.levels !== false, (v) => { w.levels = v; }, 'logs errors flagged');
    toggle('Log watch', `${p.name}: notify about flagged log lines`, () => w.notify !== false, (v) => { w.notify = v; }, 'logs errors alerts');
    page(`${p.name}: project settings…`, act('project-settings', { id: p.id }), 'auth cookies code folder scripts repo sync', 'Project');
    const env = p.envs.find((e) => e.id === p.activeEnv);
    if (env) {
      toggle('Environment', `${env.name}: skip TLS certificate verification`, () => !!env.network.insecure, (v) => { env.network.insecure = v; }, 'ssl insecure self-signed network');
      toggle('Environment', `${env.name}: HTTP/2`, () => !!env.network.http2, (v) => { env.network.http2 = v; }, 'h2 network');
    }
  }
  const loc = S.req && findReq(S.req.id);
  if (loc) {
    const r = loc.r;
    toggle('Request', `${r.name}: follow redirects`, () => r.options.followRedirects !== false, (v) => { r.options.followRedirects = v; }, '3xx location');
  }

  // ---- Pages, panels and tools
  page('Requests (close the current page)', () => setPage('request'), 'home main editor');
  page('Settings', act('open-settings'), 'preferences options');
  page('Environments', act('open-envs'), 'variables');
  page('Session test accounts', () => openAccounts(), 'creds logins passwords totp');
  page('Token sources', act('open-tokens'), 'oauth bearer');
  page('API specs', act('open-specs'), 'openapi swagger');
  page('Collection runner', act('open-runner'), 'run tests junit');
  page('Load test', act('open-load'), 'performance');
  page('Tasks & logs', act('open-tasks'), 'services java spring');
  page('Flagged log lines', act('open-log-watch'), 'log watch errors');
  page('Intercepting proxy', act('open-proxy'), 'capture');
  page('Spring Boot Actuator', act('open-actuator'), 'health loggers mappings');
  page('Compare', act('toggle-compare'), 'diff a/b environments');
  page('Recent messages (notifications)', act('notifications'), 'errors alerts');
  page('Variable history', () => openModal({ title: 'Variable history', ok: 'Close', wide: true, fields: [],
    hint: 'Every change to an environment variable on this computer, newest first: extract rules, scripts, captures and edits. Secret values are never kept.',
    html: `<div class="var-history-box">${varChangesHtml(varHistory().slice(0, 300), { showEnv: true })}</div>` }), 'variables who set extract script changes log');
  for (const [mode, label] of [['projects', 'Projects'], ['current', 'Current (feature groups)'], ['history', 'History']]) page(`Sidebar: ${label}`, act('sidebar-mode', { mode }), 'sidebar left panel', 'Sidebar');
  for (const [tab, label] of [['spec', 'Spec'], ['git', 'Git'], ['notes', 'Notes'], ['tools', 'Tools']]) page(`Side panel: ${label}`, () => openSide(tab), 'side panel right', 'Side panel');
  for (const [id, label] of TOOLS) page(`Tool: ${label}`, () => sendToTool(id, null), 'tools', 'Tools');
  return items;
}
