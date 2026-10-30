// Turning login-window traffic (main/har.js entry summaries) into saved requests.
import { newReq } from './store.js';
import { jsonChanges } from '../shared/diff.js';

// Set by the network stack or meaningless to replay.
const SKIP_HEADERS = new Set(['host', 'content-length', 'connection']);

export function requestFromCapture(entry) {
  let name = entry.url;
  try { const u = new URL(entry.url); name = u.pathname + u.search; } catch {}
  const headers = entry.headers
    .filter((h) => !h.name.startsWith(':') && !SKIP_HEADERS.has(h.name.toLowerCase()))
    .map((h) => ({ k: h.name, v: h.value, on: true }));
  const isJson = /json/i.test(entry.mimeType) || /^\s*[[{]/.test(entry.postData);
  return newReq({
    name: name.slice(0, 80),
    method: entry.method,
    url: entry.url,
    headers,
    body: entry.postData ? { type: isJson ? 'json' : 'raw', text: entry.postData, form: [] } : { type: 'none', text: '', form: [] },
  });
}

export const captureLabel = (e) => `${e.status || '—'}  ${e.method}  ${e.url}`;

// Captured calls matching the Network list's filter text (URL, method, status, or the error), newest first.
export function filterCaptured(entries, text) {
  const words = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => { const hay = `${e.method} ${e.url} ${e.status || 'failed'} ${e.error || ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); }).reverse();
}

// ---- Captured vs live: a saved captured request keeps what the page got (r.captured), so a later send or
// flow replay can be compared with it.
const MAX_CAPTURED_BODY = 100 * 1024;
// Credential-looking JSON fields (tokens, passwords, secrets, CSRF values …) blanked, so a captured body
// kept in db.json for "vs captured" doesn't hold a live token in readable form.
const CREDENTIAL_KEY = /(token|secret|password|passwd|pwd|api[-_]?key|apikey|credential|cookie|session|csrf|xsrf|signature|authorization)/i;
export const REDACTED_VALUE = '[redacted]';
function redactCredentials(text) {
  let json; try { json = JSON.parse(text); } catch { return text; }
  let changed = false;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => (CREDENTIAL_KEY.test(k) && x !== null && typeof x !== 'object' ? (changed = true, [k, REDACTED_VALUE]) : [k, walk(x)])));
  };
  const out = walk(json);
  return changed ? JSON.stringify(out) : text;
}

// detail.response (main/har.js entryDetail) → r.captured: { status, statusText, body, truncated?, at }
export function capturedOf(response, at = Date.now()) {
  if (!response) return null;
  const body = redactCredentials(String(response.body ?? ''));
  return { status: response.status, statusText: response.statusText || '', body: body.slice(0, MAX_CAPTURED_BODY), ...(body.length > MAX_CAPTURED_BODY && { truncated: true }), at };
}
// → { status: [captured, live] | null, fields: [jsonChanges] | null (both JSON), textChanged, same }
export function capturedDiff(captured, res) {
  if (!captured || !res || res.error) return null;
  const parse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
  const a = parse(captured.body), b = parse(res.body ?? '');
  // A field blanked when it was kept (a token) isn't a difference.
  const fields = a !== undefined && b !== undefined ? jsonChanges(a, b).filter((f) => f.a !== JSON.stringify(REDACTED_VALUE)) : null;
  const textChanged = fields ? fields.length > 0 : (captured.body || '') !== (res.body || '');
  const status = captured.status !== res.status ? [captured.status, res.status] : null;
  return { status, fields, textChanged, same: !status && !textChanged };
}
