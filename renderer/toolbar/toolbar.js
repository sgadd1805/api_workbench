// The dev toolbar at the top of index.html: Login window controls, Creds buttons for the saved
// test accounts (main/accounts.js; secrets stay in the main process), and HAR capture.
// Buttons that act on the app's data emit bus events that renderer/app handles.
import { $, esc, copyText, flashDone } from '../shared/html.js';
import { emit, on } from '../shared/bus.js';
import { notify } from '../shared/notify.js';
import { filterCaptured } from '../app/capture.js';
import { prettyJson, isJson, highlightJson } from '../shared/json.js';

const api = window.electronAPI;

// ---- Login controls (collapsed by default; the choice is remembered per machine)
const LOGIN_OPEN_KEY = 'toolbar-login-open';
function setLoginOpen(open) {
  $('login-controls').hidden = !open;
  const toggle = $('login-toggle');
  toggle.textContent = open ? 'Login ▾' : 'Login ▸';
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? 'Hide the login controls' : 'Show the login controls';
  try { localStorage.setItem(LOGIN_OPEN_KEY, open ? '1' : '0'); } catch {}
}
let loginOpen = false;
try { loginOpen = localStorage.getItem(LOGIN_OPEN_KEY) === '1'; } catch {}
setLoginOpen(loginOpen);
$('login-toggle').addEventListener('click', () => setLoginOpen($('login-controls').hidden));

// Login URLs come from the active environment ('session-context' from the app); "Custom URL…" shows a text box.
let context = { envName: '', loginUrls: [] };
const CUSTOM = '__custom';
function renderLoginUrls() {
  const select = $('login-url-select'), prev = select.value;
  select.innerHTML = context.loginUrls.map((u) => `<option value="${esc(u.url)}" title="${esc(u.url)}">${esc(u.label || u.url)}</option>`).join('')
    + `<option value="${CUSTOM}">Custom URL…</option>`;
  if ([...select.options].some((o) => o.value === prev)) select.value = prev;
  $('login-url-input').hidden = select.value !== CUSTOM;
  select.title = context.loginUrls.length ? `Login URLs of ${context.envName}` : 'No login URLs for the active environment (add them on the Environments page)';
}
$('login-url-select').addEventListener('change', () => { $('login-url-input').hidden = $('login-url-select').value !== CUSTOM; if (!$('login-url-input').hidden) $('login-url-input').focus(); });
on('session-context', (ctx) => {
  if (JSON.stringify(ctx) === JSON.stringify(context)) return;
  context = ctx; renderLoginUrls(); renderAccounts();
});
renderLoginUrls();

$('open-login-btn').addEventListener('click', async () => {
  const chosen = $('login-url-select').value;
  const url = chosen === CUSTOM ? $('login-url-input').value.trim() : chosen;
  const result = await api.openLoginWindow(url);
  if (!result.ok) alert('Open failed: ' + result.error);
});
$('hide-login-btn').addEventListener('click', () => api.hideLoginWindow());
$('use-session-btn').addEventListener('click', () => emit('use-login-session'));
$('investigate-btn').addEventListener('click', async () => {
  const btn = $('investigate-btn');
  btn.disabled = true; btn.textContent = 'Capturing…';
  const result = await api.investigate();
  btn.disabled = false; btn.textContent = 'Investigate';
  if (!result.ok) alert('Investigate failed: ' + (result.error || ''));
});

// ---- Network capture: the login window's XHR / Fetch calls. "Network" lists them (newest first);
// clicking one opens it in the app as a request with the response it got ('open-capture').
const NET_OPEN_KEY = 'toolbar-net-open';
let netOpen = false, netEntries = [], netShown = '', lastTicked = null;
const netSelected = new Set(); // ticked calls, by capture index
let netFocused = null; // the call shown in the detail pane
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const fmtSize = (n) => (!n ? '' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const kindOf = (mime) => (/json/i.test(mime) ? 'json' : /html/i.test(mime) ? 'html' : /xml/i.test(mime) ? 'xml' : /javascript/i.test(mime) ? 'js' : /^text\//i.test(mime) ? 'text' : /image/i.test(mime) ? 'image' : mime ? mime.split('/').pop().slice(0, 10) : '');
function urlParts(url) { try { const u = new URL(url); return { path: u.pathname + u.search, host: u.host }; } catch { return { path: url, host: '' }; } }

function renderNetList() {
  const list = filterCaptured(netEntries, $('net-filter').value);
  const key = JSON.stringify([list.map((e) => e.index), $('net-filter').value, [...netSelected]]);
  if (key === netShown) return; // unchanged: keep scroll position and focus
  netShown = key;
  $('net-list').innerHTML = list.length ? list.map((e) => {
    const { path, host } = urlParts(e.url), bad = !e.status || e.status >= 400;
    return `<div class="net-row${netSelected.has(e.index) ? ' ticked' : ''}${netFocused === e.index ? ' focused' : ''}" role="listitem" tabindex="0" data-net-index="${e.index}" title="${esc(e.method)} ${esc(e.url)}: click to see it, double-click to open it in the app">
      <input type="checkbox" class="net-tick" aria-label="Include in a flow" ${netSelected.has(e.index) ? 'checked' : ''}/><span class="net-status ${bad ? 'bad' : 'ok'}">${e.status || '✕'}</span><span class="net-method">${esc(e.method)}</span>
      <span class="net-path">${esc(path)}</span><span class="net-host">${esc(host)}</span>
      <span class="net-type">${esc(e.error || kindOf(e.responseType))}</span><span class="net-time">${fmtMs(e.time)}</span><span class="net-size">${fmtSize(e.size)}</span></div>`;
  }).join('') : `<div class="net-empty">${netEntries.length ? 'No calls match the filter.' : 'Nothing captured yet: open the login window and use the site.'}</div>`;
  const n = netSelected.size, btn = $('net-save-flow');
  btn.disabled = !n; btn.textContent = n ? `Save as flow (${n})` : 'Save as flow';
}

async function refreshNet() {
  if (netOpen) { netEntries = await api.harEntries(); renderNetList(); }
  const n = netOpen ? netEntries.length : await api.harCount();
  $('net-capture-count').textContent = String(n);
}
function setNetOpen(open) {
  netOpen = open; netShown = '';
  $('net-panel').hidden = !open;
  const t = $('net-list-toggle');
  t.firstChild.textContent = open ? 'Network ▾ ' : 'Network ▸ ';
  t.setAttribute('aria-expanded', String(open));
  try { localStorage.setItem(NET_OPEN_KEY, open ? '1' : '0'); } catch {}
  refreshNet();
}
try { setNetOpen(localStorage.getItem(NET_OPEN_KEY) === '1'); } catch { setNetOpen(false); }
setInterval(refreshNet, 2000);
$('net-list-toggle').addEventListener('click', () => setNetOpen(!netOpen));
$('net-filter').addEventListener('input', renderNetList);
const openRow = (row) => { if (!row) return; emit('open-capture', Number(row.dataset.netIndex)); row.classList.add('opened'); setTimeout(() => row.classList.remove('opened'), 700); };

// ---- The detail pane: one call's request and response, before opening it in the app.
const kv = (obj) => { const rows = Object.entries(obj || {}); return rows.length ? `<table class="net-kv">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : '<div class="net-none">none</div>'; };
const MAX_SHOWN = 20000;
function bodyHtml(text, binary) {
  if (binary) return '<div class="net-none">binary (open it in the app to preview or save it)</div>';
  if (!text) return '<div class="net-none">empty</div>';
  const shown = isJson(text) ? highlightJson(prettyJson(text).slice(0, MAX_SHOWN)) : esc(text.slice(0, MAX_SHOWN));
  return `<pre class="net-pre">${shown}${text.length > MAX_SHOWN ? '\n…' : ''}</pre>`;
}
// The highlight moves in place: re-drawing the list between the two clicks of a double-click would lose it.
function markFocused() {
  for (const row of $('net-list').querySelectorAll('.net-row')) row.classList.toggle('focused', Number(row.dataset.netIndex) === netFocused);
}
async function showDetail(index) {
  netFocused = index; markFocused();
  const pane = $('net-detail'); pane.hidden = false; pane.innerHTML = '<div class="net-none">Loading…</div>';
  const d = await api.harEntry(index);
  if (netFocused !== index) return;
  if (!d) { pane.innerHTML = '<div class="net-none">That call is no longer in the capture.</div>'; return; }
  const r = d.response, bad = !r.status || r.status >= 400;
  pane.innerHTML = `<div class="net-detail-head"><span class="net-status ${bad ? 'bad' : 'ok'}">${r.status || '✕'} ${esc(r.statusText || r.error)}</span>
      <b>${esc(d.request.method)}</b><span class="net-detail-url" title="${esc(d.request.url)}">${esc(d.request.url)}</span>
      <button class="dev-btn" id="net-open-detail">Open in app</button><button class="dev-btn" id="net-close-detail" aria-label="Close the details">✕</button></div>
    <div class="net-detail-body">
      <details open><summary>Request headers</summary>${kv(d.request.headers)}</details>
      ${d.request.body ? `<details open><summary>Payload</summary>${bodyHtml(d.request.body)}</details>` : ''}
      <details><summary>Response headers</summary>${kv(r.headers)}</details>
      <details open><summary>Response${r.time ? ` · ${fmtMs(r.time)}` : ''}${r.size ? ` · ${fmtSize(r.size)}` : ''}</summary>${bodyHtml(r.body, r.binary)}</details></div>`;
}
function hideDetail() { netFocused = null; $('net-detail').hidden = true; markFocused(); }
$('net-detail').addEventListener('click', (e) => {
  if (e.target.id === 'net-open-detail' && netFocused !== null) emit('open-capture', netFocused);
  if (e.target.id === 'net-close-detail') hideDetail();
});
$('net-list').addEventListener('dblclick', (e) => { const row = e.target.closest('[data-net-index]'); if (row && !e.target.classList.contains('net-tick')) openRow(row); });

$('net-list').addEventListener('click', (e) => {
  const row = e.target.closest('[data-net-index]'); if (!row) return;
  if (!e.target.classList.contains('net-tick')) return showDetail(Number(row.dataset.netIndex));
  // A tick: include the call in a flow; Shift-click ticks everything shown between this and the last one.
  const index = Number(row.dataset.netIndex), on = e.target.checked;
  const shown = [...$('net-list').querySelectorAll('[data-net-index]')].map((r) => Number(r.dataset.netIndex));
  const range = e.shiftKey && lastTicked !== null && shown.includes(lastTicked) ? shown.slice(Math.min(shown.indexOf(lastTicked), shown.indexOf(index)), Math.max(shown.indexOf(lastTicked), shown.indexOf(index)) + 1) : [index];
  for (const i of range) on ? netSelected.add(i) : netSelected.delete(i);
  lastTicked = index; netShown = ''; renderNetList();
});
$('net-select-all').addEventListener('click', () => {
  const shown = filterCaptured(netEntries, $('net-filter').value).map((e) => e.index);
  const all = shown.length && shown.every((i) => netSelected.has(i));
  for (const i of shown) all ? netSelected.delete(i) : netSelected.add(i);
  netShown = ''; renderNetList();
});
$('net-save-flow').addEventListener('click', () => { if (netSelected.size) emit('capture-flow', [...netSelected]); netSelected.clear(); netShown = ''; renderNetList(); });
$('net-list').addEventListener('keydown', (e) => {
  const row = e.target.closest('[data-net-index]'); if (!row) return;
  if (e.target.classList.contains('net-tick')) return;
  if (e.key === 'Enter') { e.preventDefault(); openRow(row); }
  else if (e.key === ' ') { e.preventDefault(); row.querySelector('.net-tick')?.click(); }
  else if (e.key === 'Escape' && netFocused !== null) hideDetail();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
    if (next?.dataset.netIndex) { if (netFocused !== null) showDetail(Number(next.dataset.netIndex)).then(() => $('net-list').querySelector(`[data-net-index="${next.dataset.netIndex}"]`)?.focus()); else next.focus(); }
  }
});
$('net-capture-download').addEventListener('click', () => api.downloadHar());
$('net-capture-clear').addEventListener('click', async () => { await api.clearHar(); netEntries = []; netShown = ''; netSelected.clear(); netFocused = null; $('net-detail').hidden = true; if (netOpen) renderNetList(); refreshNet(); });
$('net-capture-import').addEventListener('click', () => emit('import-capture'));
// A browser's HAR file joins the Network list (API calls only), shown straight away.
async function importHar() {
  const res = await api.harImport();
  if (!res.ok) { if (!res.canceled) notify(`HAR import failed: ${res.error}`, 'error', 8000); return; }
  notify(`Added ${res.added} call${res.added === 1 ? '' : 's'} from ${res.filePath.split(/[\\/]/).pop()} to the Network list${res.skipped ? ` (${res.skipped} page, script, style, image or font requests skipped)` : ''}`, 'info', 7000);
  netShown = ''; if (!netOpen) setNetOpen(true); else refreshNet();
}
$('net-capture-har').addEventListener('click', importHar);
on('import-har', importHar);

// ---- Creds
// When accounts are tagged with the active environment's name, only those (and untagged ones) are shown.
async function renderAccounts() {
  const all = await api.accountsList();
  const env = context.envName.trim().toLowerCase();
  const matching = env ? all.filter((a) => a.env.trim().toLowerCase() === env) : [];
  const accounts = matching.length ? [...matching, ...all.filter((a) => !a.env.trim())] : all;
  const byEnv = new Map();
  for (const a of accounts) { if (!byEnv.has(a.env)) byEnv.set(a.env, []); byEnv.get(a.env).push(a); }
  $('creds-buttons').innerHTML = [...byEnv].map(([env, list], i) =>
    `${i ? '<span class="dev-toolbar-sep" style="height:16px"></span>' : ''}${env ? `<span class="dev-toolbar-env-label">${esc(env)}</span>` : ''}`
    + list.map((a) => `<button class="dev-btn cred-btn" data-id="${esc(a.id)}" title="${esc(a.user)}">${esc(a.label)}</button>`).join('')).join('')
    || '<span class="dev-toolbar-env-label">no accounts</span>';
  return accounts;
}
renderAccounts();
on('accounts-changed', renderAccounts);
$('creds-edit').addEventListener('click', () => emit('open-accounts'));

// The selected account's preview: user, copy buttons, and a live TOTP code polled from main.
let active = null, totpInterval = null;

async function refreshTotp() {
  const el = $('creds-totp-code');
  if (!el || !active) return;
  const t = await api.accountsTotp(active.id);
  el.textContent = t.ok ? t.code : 'error';
  el.classList.toggle('expiring', t.ok && t.secondsLeft <= 5);
  $('creds-totp-timer').textContent = t.ok ? t.secondsLeft + 's' : '';
}

async function onCredClick(btn) {
  active = (await api.accountsList()).find((a) => a.id === btn.dataset.id);
  if (!active) return;
  const result = await api.accountsFill(active.id);
  $('creds-preview').innerHTML = `<span>${esc(active.user)}</span>
    <button class="creds-copy" data-copy="user">user</button>
    ${active.hasPass ? '<button class="creds-copy" data-copy="pass">pass</button>' : ''}
    ${active.hasTotp ? '<div id="creds-totp"><span class="totp-code" id="creds-totp-code">------</span><span class="totp-timer" id="creds-totp-timer"></span><button class="creds-copy" data-copy="totp">copy</button></div>' : ''}`;
  clearInterval(totpInterval);
  if (active.hasTotp) { await refreshTotp(); totpInterval = setInterval(refreshTotp, 1000); }
  if (!result.ok) {
    // Flag the button with a "!" for a moment when the fill failed (e.g. login window not open).
    const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
    btn.textContent = label + '!'; btn.title = result.error || '';
    clearTimeout(btn._flagTimer);
    btn._flagTimer = setTimeout(() => { btn.textContent = label; }, 1500);
  }
}

async function copyField(field) {
  if (field === 'user') return active.user;
  if (field === 'totp') return (await api.accountsTotp(active.id)).code;
  return (await api.accountsSecret(active.id, 'pass')).value;
}

$('dev-toolbar').addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.creds-copy');
  if (copyBtn && active) { await copyText(await copyField(copyBtn.dataset.copy)); flashDone(copyBtn); return; }
  const credBtn = e.target.closest('.cred-btn');
  if (credBtn) onCredClick(credBtn);
});
