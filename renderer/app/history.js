// Every send, newest first: the sidebar's History panel and each request's History tab.
// Persisted by main/history.js (bodies over 100 KB are truncated on disk; this session's sends
// keep their full bodies in memory until restart).
//
// Entry: { id, at, reqId, reqName, projectId, method, url (as sent, variables resolved),
//          request: { headers, body }, response: { status, statusText, headers, body, time, timing, truncated? } | null,
//          error: string | null }
import { uid } from './store.js';
import { recordTiming } from './timings.js';

const MAX_ENTRIES = 200; // matches main/history.js

let entries = [];

export async function loadHistory() { entries = (await window.electronAPI.historyLoad()) || []; }
export const historyEntries = () => entries;
export const historyEntry = (id) => entries.find((e) => e.id === id) || null;

export function entryFromSend(loc, res, now = Date.now()) {
  const sent = res.requestData || {};
  return {
    id: uid(), at: now, reqId: loc.r.id, reqName: loc.r.name, projectId: loc.p.id,
    method: sent.method || loc.r.method, url: sent.url || loc.r.url,
    request: { headers: sent.headers || {}, body: sent.body || '' },
    response: res.error ? null : { status: res.status, statusText: res.statusText, headers: res.headers, body: res.body, time: res.time, timing: res.timing },
    error: res.error || null,
  };
}

// Cancelled sends aren't recorded; errors (timeouts, refused connections, …) are. The response time also
// goes into the request's trend (timings.js), and res.slow says whether it was markedly slower than the
// request's usual runs in that environment (envId: the environment it was sent in; default the active one).
export function recordHistory(loc, res, { envId = loc?.p?.activeEnv ?? null } = {}) {
  if (!res || res.cancelled) return null;
  res.slow = recordTiming(loc, res, envId);
  const entry = entryFromSend(loc, res);
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  window.electronAPI.historyAppend(entry);
  return entry;
}

// Traffic captured by the intercepting proxy (actions/proxy.js): no saved request behind it.
export function recordExchange(x) {
  let host = x.url; try { host = new URL(x.url).host; } catch { /* keep the raw URL */ }
  const entry = {
    id: uid(), at: x.at, reqId: null, reqName: `⇄ ${host}`, projectId: null, source: 'proxy',
    method: x.method, url: x.url,
    request: { headers: x.requestHeaders || {}, body: x.request?.binary ? '' : x.request?.body || '' },
    response: x.error ? null : { status: x.status, statusText: x.statusText, headers: x.responseHeaders || {}, body: x.response?.body || '', time: x.time, timing: null },
    error: x.error || null,
  };
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  window.electronAPI.historyAppend(entry);
  return entry;
}

export function deleteHistoryEntry(id) { entries = entries.filter((e) => e.id !== id); window.electronAPI.historyDelete(id); }
export function clearHistory() { entries = []; window.electronAPI.historyClear(); }

// Successful runs of one request, shaped like send() results plus `at`, for the response History tab.
export function runsFor(reqId, max = 10) {
  return entries.filter((e) => e.reqId === reqId && e.response).slice(0, max).map((e) => ({ ...e.response, at: e.at }));
}

// The panel's search: every word must appear in the method, URL, status, request name or error.
export function matchesQuery(e, query) {
  const hay = `${e.method} ${e.url} ${e.response?.status ?? 'error'} ${e.reqName} ${e.error ?? ''}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

// → [{ label: 'Today' | 'Yesterday' | 'Mon 26 Oct', entries }] in the given (newest-first) order.
export function groupByDay(list, now = Date.now()) {
  const today = dayStart(now), DAY = 86400000;
  const groups = [];
  for (const e of list) {
    const start = dayStart(e.at);
    const label = start === today ? 'Today' : start === today - DAY ? 'Yesterday'
      : new Date(e.at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: new Date(e.at).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
    if (groups.at(-1)?.label !== label) groups.push({ label, entries: [] });
    groups.at(-1).entries.push(e);
  }
  return groups;
}
