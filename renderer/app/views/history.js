// History: the sidebar list (when S.sidebarMode === 'history') and the entry page (S.page === 'history').
import { $, esc } from '../../shared/html.js';
import { isJson, prettyJson } from '../../shared/json.js';
import { S, findReq } from '../store.js';
import { historyEntries, historyEntry, matchesQuery, groupByDay } from '../history.js';
import { responseHtml } from './response.js';
import { icon } from '../../shared/icons.js';

const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Path + query for the list (host is in the tooltip); the raw text when it isn't a parseable URL.
function shortUrl(url) {
  try { const u = new URL(url); return { short: u.pathname + u.search || '/', host: u.host }; } catch { return { short: url, host: '' }; }
}

function statusHtml(e) {
  if (e.error) return `<span class="history-status err" title="${esc(e.error)}">ERR</span>`;
  return `<span class="history-status ${e.response.status < 400 ? 'ok' : 'err'}">${e.response.status}</span>`;
}

function rowHtml(e) {
  const { short, host } = shortUrl(e.url);
  const active = S.page === 'history' && S.history.id === e.id;
  return `<div class="sidebar-item history-item${active ? ' active' : ''}" data-action="history-open" data-id="${esc(e.id)}"
      title="${esc(`${e.method} ${e.url}\n${host ? host + ' · ' : ''}${e.reqName} · ${new Date(e.at).toLocaleString()}`)}">
    <span class="method-tag m-${esc(e.method)}">${esc(e.method)}</span><span class="item-name">${esc(short)}</span>${statusHtml(e)}<span class="hint">${fmtClock(e.at)}</span></div>`;
}

// Only the list re-renders while typing in the search box, so the box keeps focus.
export function renderHistoryList() {
  const all = historyEntries();
  const shown = S.history.filter.trim() ? all.filter((e) => matchesQuery(e, S.history.filter)) : all;
  $('history-list').innerHTML = shown.length
    ? groupByDay(shown).map((g) => `<div class="history-day">${esc(g.label)}</div>${g.entries.map(rowHtml).join('')}`).join('')
    : `<div class="pad-10 hint">${all.length ? 'No matches' : 'Nothing sent yet'}</div>`;
  $('history-count').textContent = all.length ? `${shown.length === all.length ? all.length : `${shown.length} of ${all.length}`} request${all.length === 1 ? '' : 's'}` : '';
}

const headerLines = (h) => Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join('\n');

// The response in the shape responseHtml() expects.
export const historyResponse = (e) => (e.error ? { error: e.error } : { ...e.response, requestData: { method: e.method, url: e.url, ...e.request } });

export function historyPageHtml() {
  const e = historyEntry(S.history.id);
  if (!e) return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button><h3>History</h3></div><p class="hint">This entry no longer exists.</p>`;
  const loc = e.reqId && findReq(e.reqId);
  const body = e.request.body ? '\n\n' + (isJson(e.request.body) ? prettyJson(e.request.body) : e.request.body) : '';
  const truncated = e.request.truncated || e.response?.truncated;
  return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button>
      <h3><span class="method-tag m-${esc(e.method)}">${esc(e.method)}</span> ${esc(e.url)}</h3></div>
    <div class="mb-8 hint">${esc(new Date(e.at).toLocaleString())} · from ${loc ? `"${esc(loc.r.name)}" in ${esc(loc.p.name)}` : `"${esc(e.reqName)}" (since deleted)`}</div>
    <div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">
      ${loc ? '<button class="btn-ghost small" data-action="history-open-req">Open request</button>' : ''}
      <button class="btn-ghost small" data-action="history-save-as" title="Create a request from exactly what was sent">Save as request…</button>
      <button class="btn-ghost small" data-action="history-curl">Copy as cURL</button>
      <button class="btn-ghost small" data-action="history-delete">Delete entry</button></div>
    ${truncated ? '<p class="mb-8 warn-text">⚠ A body over 100 KB was truncated when history was saved.</p>' : ''}
    <h4 class="section-title">Request (as sent)</h4>
    <pre class="mb-14 resp-body">${esc(`${e.method} ${e.url}\n${headerLines(e.request.headers)}${body}`)}</pre>
    <h4 class="section-title">Response</h4>
    <div>${responseHtml(historyResponse(e), [], 'history', S.history.resTab)}</div>`;
}
