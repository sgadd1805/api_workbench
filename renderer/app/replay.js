// Re-sending a History entry with one thing changed (a header, a query parameter, a body field, or the
// environment), and comparing the new response with the one recorded. Pure functions; the History page's
// actions (actions/history.js) send and record. Used by the History entry page.
//
// Change: { kind: 'none' | 'header' | 'query' | 'body' | 'env', name, value, remove: bool, envId }
import { jsonChanges, lineDiff, diffStats } from '../shared/diff.js';
import { prettyJson } from '../shared/json.js';

export const CHANGE_KINDS = [['header', 'Header'], ['query', 'Query parameter'], ['body', 'Body field'], ['env', 'Environment'], ['none', 'Nothing (send again)']];

// Headers that describe the old exchange rather than the request: rebuilt by main/http.js for the new one.
const TRANSPORT = /^(content-length|host|connection|transfer-encoding|keep-alive)$/i;
// Values History replaced on disk (main/secrets.js redactHeaders, redactText).
export const REDACTED_HEADER = /•••• \(redacted\)|\[REDACTED\]|\[redacted\]/;

const findKey = (obj, name) => Object.keys(obj).find((k) => k.toLowerCase() === String(name).toLowerCase());

// What was sent, ready to send again. → { method, url, headers, body, bodyParts?, bodyFile? }
export function wireFromEntry(e) {
  const headers = {};
  for (const [k, v] of Object.entries(e.request?.headers || {})) if (!k.startsWith(':') && !TRANSPORT.test(k)) headers[k] = v;
  return {
    method: e.method, url: e.url, headers, body: e.request?.body || '',
    ...(e.request?.parts?.length && { bodyParts: structuredClone(e.request.parts) }), ...(e.request?.file && { bodyFile: e.request.file }),
  };
}

// Headers the app adds to every send (main/http.js defaults, X-Request-Id / traceparent correlation).
// A request saved from a recorded send leaves them out, so each send gets its own again.
const AUTO_HEADERS = { accept: '*/*', 'accept-encoding': 'gzip, deflate, br', 'user-agent': /^api-workbench\// };
export function savableHeaders(headers) {
  return Object.entries(headers || {}).filter(([k, v]) => {
    const name = k.toLowerCase(), auto = AUTO_HEADERS[name];
    if (k.startsWith(':') || TRANSPORT.test(k) || name === 'x-request-id' || name === 'traceparent') return false;
    return !(auto instanceof RegExp ? auto.test(String(v)) : auto === v);
  }).map(([k, v]) => ({ k, v: String(v), on: true }));
}

// A re-send gets new correlation ids (when the recorded send had them), so its server logs don't
// mix with the original's. corr: { requestId, traceparent } (tasks.js newCorrelation).
export function renewCorrelation(wire, corr) {
  for (const k of Object.keys(wire.headers)) {
    if (/^x-request-id$/i.test(k)) wire.headers[k] = corr.requestId;
    else if (/^traceparent$/i.test(k)) wire.headers[k] = corr.traceparent;
  }
  return wire;
}

// Header values History blanked out (credentials). → [name]
export const redactedHeaders = (wire) => Object.entries(wire.headers).filter(([, v]) => REDACTED_HEADER.test(String(v))).map(([k]) => k);

// Fills blanked-out headers from `fresh` (the saved request's headers built now). → names that couldn't be filled
export function fillRedacted(wire, fresh = {}) {
  const missing = [];
  for (const k of redactedHeaders(wire)) {
    const fk = findKey(fresh, k);
    if (fk && !REDACTED_HEADER.test(fresh[fk])) wire.headers[k] = fresh[fk];
    else { delete wire.headers[k]; missing.push(k); }
  }
  return missing;
}

// A typed value: JSON when it parses (123, true, null, "text", {…}), else the text itself.
export function parseValue(text) {
  const s = String(text ?? '');
  try { return JSON.parse(s); } catch { return s; }
}

// 'items[0].name', '$.items.0.name', 'a["odd key"]' → ['items', 0, 'name']
export function parsePath(path) {
  const out = [];
  const s = String(path || '').trim().replace(/^\$\.?/, '');
  const re = /\[\s*(\d+)\s*\]|\[\s*"((?:[^"\\]|\\.)*)"\s*\]|\[\s*'([^']*)'\s*\]|([^.[\]]+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) out.push(Number(m[1]));
    else if (m[2] !== undefined) out.push(JSON.parse(`"${m[2]}"`));
    else if (m[3] !== undefined) out.push(m[3]);
    else out.push(/^\d+$/.test(m[4]) ? Number(m[4]) : m[4]);
  }
  return out;
}

// Sets (or removes) a value at a path, creating objects / arrays on the way. → the (possibly new) root
export function setAtPath(root, path, value, remove = false) {
  const keys = parsePath(path);
  if (!keys.length) return remove ? undefined : value;
  const top = root && typeof root === 'object' ? root : typeof keys[0] === 'number' ? [] : {};
  let node = top;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!node[k] || typeof node[k] !== 'object') { if (remove) return top; node[k] = typeof keys[i + 1] === 'number' ? [] : {}; }
    node = node[k];
  }
  const last = keys.at(-1);
  if (remove) { if (Array.isArray(node) && typeof last === 'number') node.splice(last, 1); else delete node[last]; } else node[last] = value;
  return top;
}

const contentType = (wire) => wire.headers[findKey(wire.headers, 'content-type')] || '';

// Applies one change to a wire request (a copy). → { wire, error? }
export function applyChange(wire, change) {
  const w = structuredClone(wire);
  const name = String(change?.name || '').trim();
  switch (change?.kind) {
    case 'header': {
      if (!name) return { wire: w, error: 'Name the header to change' };
      const k = findKey(w.headers, name);
      if (k) delete w.headers[k];
      if (!change.remove) w.headers[k || name] = String(change.value ?? '');
      return { wire: w };
    }
    case 'query': {
      if (!name) return { wire: w, error: 'Name the query parameter to change' };
      return { wire: { ...w, url: withParam(w.url, name, change.remove ? null : String(change.value ?? '')) } };
    }
    case 'body': return changeBody(w, name, change);
    default: return { wire: w };
  }
}

// Replaces (or with value null removes) every occurrence of a query parameter, keeping the rest as written.
function withParam(url, name, value) {
  const [beforeHash, hash = ''] = url.split(/#(.*)/s);
  const ix = beforeHash.indexOf('?');
  const base = ix < 0 ? beforeHash : beforeHash.slice(0, ix);
  const pairs = ix < 0 ? [] : beforeHash.slice(ix + 1).split('&').filter(Boolean);
  const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
  const kept = pairs.filter((p) => dec(p.split('=')[0]) !== name);
  if (value !== null) kept.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  return base + (kept.length ? '?' + kept.join('&') : '') + (hash ? '#' + hash : '');
}

function changeBody(w, name, change) {
  if (!name) return { wire: w, error: 'Give the field to change (a JSON path like items[0].qty, or a form field name)' };
  if (w.bodyParts) {
    const parts = w.bodyParts.filter((p) => p.name !== name || p.file != null);
    if (!change.remove) parts.push({ name, value: String(change.value ?? '') });
    return { wire: { ...w, bodyParts: parts } };
  }
  if (w.bodyFile) return { wire: w, error: 'The body is a file; change a header or query parameter instead' };
  if (/x-www-form-urlencoded/i.test(contentType(w))) {
    return { wire: { ...w, body: withParam('?' + w.body, name, change.remove ? null : String(change.value ?? '')).slice(1) } };
  }
  let json;
  try { json = w.body ? JSON.parse(w.body) : {}; } catch { return { wire: w, error: 'The body isn\'t JSON or a form, so there are no fields to change' }; }
  const out = setAtPath(json, name, parseValue(change.value), !!change.remove);
  return { wire: { ...w, body: out === undefined ? '' : JSON.stringify(out, null, isPretty(w.body) ? 2 : 0) } };
}
const isPretty = (body) => /\n\s/.test(body || '');

// A short label for the change, for History and the comparison heading.
export function describeChange(change, envName = '') {
  const v = (s) => (String(s ?? '').length > 60 ? String(s).slice(0, 57) + '…' : String(s ?? ''));
  switch (change?.kind) {
    case 'header': return change.remove ? `without header ${change.name}` : `header ${change.name}: ${v(change.value)}`;
    case 'query': return change.remove ? `without ?${change.name}` : `?${change.name}=${v(change.value)}`;
    case 'body': return change.remove ? `without body ${change.name}` : `body ${change.name} = ${v(change.value)}`;
    case 'env': return `in environment ${envName || '(none)'}`;
    default: return 'sent again unchanged';
  }
}

const IGNORED_HEADERS = /^(date|x-request-id|traceparent|age|expires|last-modified|etag|set-cookie|x-correlation-id|x-trace-id|server-timing|content-length)$/i;

// Recorded response (a) vs new one (b). → { status: [a, b], time: [a, b], headers: [{ name, a, b }],
//   fields: JSON field changes | null (when either body isn't JSON), bodySame, rows: line diff of the bodies, stats }
export function compareResponses(a, b) {
  const ah = a?.headers || {}, bh = b?.headers || {};
  const names = [...new Set([...Object.keys(ah), ...Object.keys(bh)].map((k) => k.toLowerCase()))].filter((k) => !IGNORED_HEADERS.test(k)).sort();
  const get = (h, k) => h[findKey(h, k)];
  const headers = names.filter((k) => get(ah, k) !== get(bh, k)).map((name) => ({ name, a: get(ah, name) ?? null, b: get(bh, name) ?? null }));
  const parse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  const ja = parse(a?.body ?? ''), jb = parse(b?.body ?? '');
  const fields = ja !== undefined && jb !== undefined ? jsonChanges(ja, jb) : null;
  const rows = lineDiff(prettyJson(a?.body ?? ''), prettyJson(b?.body ?? ''), { ignoreWhitespace: true });
  return {
    status: [a?.status ?? null, b?.status ?? null], time: [a?.time ?? null, b?.time ?? null],
    headers, fields, bodySame: (a?.body ?? '') === (b?.body ?? '') || (fields !== null && fields.length === 0), rows, stats: diffStats(rows),
  };
}

// Names to offer for a kind of change (a <datalist>): the entry's headers, query parameters, or body fields
// (JSON leaf paths like items[0].qty, form field or multipart part names).
export function nameSuggestions(e, kind, max = 200) {
  const wire = wireFromEntry(e);
  if (kind === 'header') return Object.keys(wire.headers);
  if (kind === 'query') {
    const q = wire.url.split('#')[0].split('?')[1] || '';
    return [...new Set(q.split('&').filter(Boolean).map((p) => { try { return decodeURIComponent(p.split('=')[0].replace(/\+/g, ' ')); } catch { return p.split('=')[0]; } }))];
  }
  if (kind !== 'body') return [];
  if (wire.bodyParts) return [...new Set(wire.bodyParts.filter((p) => p.file == null).map((p) => p.name))];
  if (/x-www-form-urlencoded/i.test(contentType(wire))) return nameSuggestions({ ...e, url: '?' + wire.body, request: { headers: {} } }, 'query', max);
  let json; try { json = JSON.parse(wire.body); } catch { return []; }
  const out = [];
  const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `["${k.replace(/"/g, '\\"')}"]`);
  const walk = (v, path) => {
    if (out.length >= max) return;
    if (v && typeof v === 'object') {
      const entries = Array.isArray(v) ? v.map((x, i) => [`[${i}]`, x]) : Object.entries(v).map(([k, x]) => [key(k), x]);
      if (!entries.length && path) out.push(path);
      for (const [k, x] of entries) walk(x, path ? (k.startsWith('[') ? path + k : `${path}.${k}`) : k.replace(/^\["/, '["'));
    } else if (path) out.push(path);
  };
  walk(json, '');
  return out;
}
