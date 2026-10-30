// Tools window entry point (tools.html): tab bar, history sidebar, and event dispatch to the
// active tab. Each tool lives in tabs/<id>.js and default-exports:
//
//   { id, label,
//     state: { … },          initial values, merged into S
//     keys: [ … ],           S fields saved to / restored from history
//     sensitive?: true,      history keeps a short label only, no snapshot
//     primary(S) → string,   the history entry's label ('' = nothing to record)
//     render(S) → html,
//     onInput?(el, ctx), onClick?(target, ctx), onChange?(el, ctx), onRestore?(ctx),
//     receive?(S, value)     a value sent from the main window ("send to tool") }
//
// To add a tool, write the module and add it to TABS.
import { $, esc } from '../shared/html.js';
import { redactCredentials } from '../shared/redact.js';
import { fmtClock } from './lib/time.js';
import { api, embedded } from './api.js';
import jwt from './tabs/jwt.js';
import url from './tabs/url.js';
import base64 from './tabs/base64.js';
import json from './tabs/json.js';
import diff from './tabs/diff.js';
import hash from './tabs/hash.js';
import timestamp from './tabs/timestamp.js';
import regex from './tabs/regex.js';
import xml from './tabs/xml.js';
import string from './tabs/string.js';

const TABS = [jwt, url, base64, json, diff, hash, timestamp, regex, xml, string];
const TAB = Object.fromEntries(TABS.map((t) => [t.id, t]));

// ---- History (localStorage)
const MAX_HISTORY = 50;
const HISTORY_KEY = 'tools-history';
// History kept in localStorage holds no credentials: sensitive tools keep a short label only, the others'
// text goes through redactCredentials. Entries saved before that are cleaned once when loaded.
function cleanEntry(h) {
  const tab = TAB[h.tab];
  if (!tab) return h;
  if (tab.sensitive) return { ...h, label: String(h.label || '').slice(0, 12).replace(/…?$/, '…'), snapshot: {}, clean: true };
  return { ...h, label: redactCredentials(h.label), snapshot: Object.fromEntries(Object.entries(h.snapshot || {}).map(([k, v]) => [k, typeof v === 'string' ? redactCredentials(v) : v])), clean: true };
}
function loadHistory() {
  let list; try { list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
  if (!list.some((h) => !h.clean)) return list;
  const cleaned = list.map((h) => (h.clean ? h : cleanEntry(h)));
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(cleaned)); } catch { /* kept in memory */ }
  return cleaned;
}
function saveHistory() { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(S.history)); } catch {} }

const S = Object.assign({ tab: TABS[0].id, history: loadHistory(), activeHistId: null }, ...TABS.map((t) => structuredClone(t.state)));

function record() {
  const tab = TAB[S.tab];
  const input = (tab.primary(S) || '').trim(); if (!input) return;
  const label = tab.sensitive ? input.slice(0, 12) + '…' : redactCredentials(input).slice(0, 80);
  const latest = S.history.find((h) => h.tab === S.tab);
  if (latest && latest.label === label) return;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const snapshot = tab.sensitive ? {} : Object.fromEntries(tab.keys.map((k) => [k, typeof S[k] === 'string' ? redactCredentials(S[k]) : S[k]]));
  S.history.unshift({ id, tab: S.tab, label, snapshot, ts: Date.now(), clean: true });
  if (S.history.length > MAX_HISTORY) S.history.length = MAX_HISTORY;
  S.activeHistId = id; saveHistory(); renderHistory();
}

let recordTimer = null;
function recordSoon() { clearTimeout(recordTimer); recordTimer = setTimeout(() => { recordTimer = null; record(); }, 1200); }
// record() reads the active tab, so a pending record must run before the tab changes.
function flushRecord() { if (recordTimer) { clearTimeout(recordTimer); recordTimer = null; record(); } }

function switchTab(id) { flushRecord(); S.tab = id; S.activeHistId = null; render(); }

function restore(item) {
  const tab = TAB[item.tab]; if (!tab) return;
  flushRecord();
  for (const k of tab.keys) if (k in (item.snapshot || {})) S[k] = item.snapshot[k];
  S.tab = item.tab; S.activeHistId = item.id;
  tab.onRestore?.(ctx);
  render();
}

// ---- Rendering
function setContent() { $('content').innerHTML = TAB[S.tab].render(S); }

// Re-render the tab but put focus and the cursor back in element `id` (for live-updating inputs).
function keepFocus(id) {
  const pos = $(id)?.selectionStart;
  setContent();
  const el = $(id); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
}

function renderHistory() {
  $('history-list').innerHTML = S.history.length
    ? S.history.map((h) => `<div class="hist-item${h.id === S.activeHistId ? ' active' : ''}" data-hist-id="${esc(h.id)}">
        <div class="hist-tab-badge">${esc(TAB[h.tab]?.label || h.tab)}</div>
        <div class="hist-label">${esc(h.label)}</div>
        <div class="hist-time">${fmtClock(h.ts)}</div></div>`).join('')
    : '<div style="padding:10px;font-size:11px;color:var(--text-muted)">No history yet</div>';
}

function render() {
  const prevId = document.activeElement?.id;
  $('tabs').innerHTML = TABS.map((t) => `<button class="tab${S.tab === t.id ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')
    + (embedded ? '' : '<button class="btn-ghost small tools-dock" data-dock title="Show Tools in the main window\'s side panel instead">⇤ Dock</button>');
  renderHistory();
  if (prevId) keepFocus(prevId); else setContent();
}

// What tab handlers get as their second argument.
const ctx = {
  S,
  rerender: setContent,
  keepFocus,
  recordSoon,
  record,
  renderHistory,
  // The usual reaction to typing: re-render with focus kept, and record history after a pause.
  changed(el) { recordSoon(); keepFocus(el.id); },
};

// ---- Events
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-dock]')) return api.dockTools();
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) return switchTab(tabBtn.dataset.tab);
  const histItem = e.target.closest('[data-hist-id]');
  if (histItem) { const item = S.history.find((x) => x.id === histItem.dataset.histId); if (item) restore(item); return; }
  TAB[S.tab].onClick?.(e.target, ctx);
});
document.addEventListener('input', (e) => TAB[S.tab].onInput?.(e.target, ctx));
document.addEventListener('change', (e) => TAB[S.tab].onChange?.(e.target, ctx));

// ---- values sent from the main window, and its theme
function receive({ tool, value }) {
  if (value == null && TAB[tool]) return switchTab(tool); // "open this tool" (⌘K in the main window)
  const tab = TAB[tool]; if (!tab?.receive) return;
  flushRecord();
  S.tab = tool; S.activeHistId = null;
  tab.receive(S, String(value ?? ''));
  render(); recordSoon();
}
const applyTheme = (theme) => { document.documentElement.dataset.theme = theme || 'dark'; };
window.addEventListener('message', (e) => {
  if (e.data?.type === 'tools:send') receive(e.data);
  if (e.data?.type === 'tools:theme') applyTheme(e.data.theme);
});
if (!embedded) api.onToolsSend(receive); // the main process forwards to the popped-out window
if (embedded) document.body.classList.add('embedded');
api.storageGet().then((d) => applyTheme(d?.db?.settings?.theme)).catch(() => applyTheme('dark'));

render();
