// Spec-driven fuzzing: from an operation and a request that works, cases that each change one thing —
// a missing required field, a wrong type, a value just outside a limit, an oversized or odd string, a
// malformed body, no credentials — and how to judge the response.
//
// Case: { id, group: 'body' | 'query' | 'path' | 'header' | 'auth', where: 'body.items[0].qty' | 'query.limit' | …,
//         label, expect: 'reject' (a 4xx is right) | 'auth' (401 / 403) | 'any' (anything but a 5xx),
//         mutate(wire) → wire }
// Verdicts (judgeCase): 'ok', 'server-error' (5xx), 'accepted' (invalid input got a 2xx / 3xx), 'auth-open' (no
// credentials and no 401 / 403), 'no-response' (connection error / timeout), 'off-spec' (the response doesn't match
// the spec; a warning, not a failure).
import { deref } from './spec.js';
import { pickMedia, isJsonMedia, validateResponse } from './validate.js';

export const VERDICTS = {
  ok: { label: 'OK', level: 'pass' },
  'server-error': { label: 'Server error', level: 'fail' },
  accepted: { label: 'Accepted invalid input', level: 'fail' },
  'auth-open': { label: 'Worked without credentials', level: 'fail' },
  'no-response': { label: 'No response', level: 'fail' },
  'off-spec': { label: 'Response not in the spec', level: 'warn' },
};

const OVERSIZED = 64 * 1024;
const LONG = 5000;
const ODD_STRINGS = [
  ['quotes and markup', `'"<script>alert(1)</script>\\`],
  ['SQL-like text', "' OR '1'='1'; --"],
  ['unicode and emoji', 'Zoë 名前 🚀 ‮right-to-left'],
  ['control characters', 'a\u0000b\u0007c\r\nd'],
  ['whitespace only', '   '],
];
const BAD_FORMATS = {
  email: 'not-an-email', uuid: 'not-a-uuid', date: '2021-13-45', 'date-time': 'yesterday at noon', time: '25:61',
  uri: 'not a uri', url: 'not a url', ipv4: '999.1.1.1', ipv6: 'not:an:ip', byte: '***not base64***', hostname: '-bad-.host-',
};

const typeOf = (s) => [].concat(s?.type || (s?.properties ? 'object' : s?.items ? 'array' : [])).find((t) => t !== 'null');
const nullable = (s) => s?.nullable === true || [].concat(s?.type || []).includes('null');
const headerKey = (h, name) => Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
const keyPath = (path, k) => (typeof k === 'number' ? `${path}[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}["${k}"]`);

// A value of a different JSON type than the schema wants.
function wrongType(t) {
  switch (t) {
    case 'string': return [12345, 'a number'];
    case 'integer': case 'number': return ['not-a-number', 'text'];
    case 'boolean': return ['yes', 'text'];
    case 'array': return [{ not: 'an array' }, 'an object'];
    case 'object': return ['not-an-object', 'text'];
    default: return null;
  }
}

// Values just outside (reject) or at odd edges (any) of a scalar schema. → [{ value, label, expect }]
function scalarCases(s, { asString = false, oversized = true } = {}) {
  const out = [], t = typeOf(s);
  const add = (value, label, expect) => out.push({ value: asString && typeof value !== 'string' ? String(value) : value, label, expect });
  if (s.enum?.length) add(typeof s.enum[0] === 'number' ? 987654321 : 'NOT_AN_ALLOWED_VALUE', `not one of ${s.enum.slice(0, 4).map((x) => JSON.stringify(x)).join(', ')}${s.enum.length > 4 ? ' …' : ''}`, 'reject');
  if (t === 'string') {
    if (s.minLength > 0) add('x'.repeat(s.minLength - 1), `shorter than minLength ${s.minLength}`, 'reject');
    else if (!s.enum && !s.format) add('', 'empty string', 'any');
    if (s.maxLength != null) add('x'.repeat(s.maxLength + 1), `longer than maxLength ${s.maxLength}`, 'reject');
    if (BAD_FORMATS[s.format]) add(BAD_FORMATS[s.format], `invalid ${s.format}`, 'reject');
    if (s.pattern) add('~!@#$%^&*()', `doesn't match pattern ${s.pattern}`, 'reject');
    if (!s.enum && !s.format) for (const [label, v] of ODD_STRINGS) add(v, label, 'any');
    if (s.maxLength == null) add('x'.repeat(oversized ? OVERSIZED : LONG), `oversized (${oversized ? '64 KB' : '5,000 characters'})`, 'any');
  }
  if (t === 'integer' || t === 'number') {
    const min = typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum : s.minimum;
    const max = typeof s.exclusiveMaximum === 'number' ? s.exclusiveMaximum : s.maximum;
    const exMin = typeof s.exclusiveMinimum === 'number' || s.exclusiveMinimum === true;
    const exMax = typeof s.exclusiveMaximum === 'number' || s.exclusiveMaximum === true;
    if (min != null) add(exMin ? min : min - (t === 'integer' ? 1 : 0.5), `below the minimum ${min}${exMin ? ' (exclusive)' : ''}`, 'reject');
    else add(-1, 'negative', 'any');
    if (max != null) add(exMax ? max : max + (t === 'integer' ? 1 : 0.5), `above the maximum ${max}${exMax ? ' (exclusive)' : ''}`, 'reject');
    else add(t === 'integer' ? '99999999999999999999' : 1e308, 'huge number', 'any');
    if (t === 'integer') add(1.5, 'a fraction for an integer', 'reject');
    if (min == null) add(0, 'zero', 'any');
  }
  return out;
}

// ---- wire edits
function setJson(wire, path, fn) {
  let json; try { json = JSON.parse(wire.body); } catch { return wire; }
  const out = fn(json);
  // A huge integer stays a bare number in the JSON text (it can't be one in JS).
  const text = JSON.stringify(out === undefined ? json : out, (k, v) => (v && v.__raw ? `__RAW__${v.__raw}__RAW__` : v)).replace(/"__RAW__(.*?)__RAW__"/g, '$1');
  return { ...wire, body: text };
}
const rawNumber = (v) => (typeof v === 'string' && /^\d{15,}$/.test(v) ? { __raw: v } : v);

// keys: ['items', 0, 'qty'] into a parsed body
function editAt(root, keys, fn) {
  let node = root;
  for (const k of keys.slice(0, -1)) { node = node?.[k]; if (!node || typeof node !== 'object') return root; }
  fn(node, keys.at(-1));
  return root;
}

function withQuery(url, name, value) {
  const [beforeHash, hash] = url.split(/#(.*)/s);
  const ix = beforeHash.indexOf('?');
  const base = ix < 0 ? beforeHash : beforeHash.slice(0, ix);
  const pairs = (ix < 0 ? '' : beforeHash.slice(ix + 1)).split('&').filter(Boolean)
    .filter((p) => { try { return decodeURIComponent(p.split('=')[0].replace(/\+/g, ' ')) !== name; } catch { return true; } });
  if (value !== null) pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  return base + (pairs.length ? '?' + pairs.join('&') : '') + (hash ? '#' + hash : '');
}

// Replaces the path segment holding {name} (the URL's last segments line up with the template's).
export function withPathParam(url, template, name, value) {
  const m = /^([a-z][\w+.-]*:\/\/[^/?#]*)?([^?#]*)(.*)$/i.exec(url);
  const origin = m[1] || '', path = m[2], rest = m[3];
  const trailing = path.length > 1 && path.endsWith('/');
  const segs = (trailing ? path.slice(0, -1) : path).split('/');
  const tsegs = template.replace(/\/$/, '').split('/');
  const offset = segs.length - tsegs.length;
  if (offset < 0) return null;
  const i = tsegs.findIndex((t) => t === `{${name}}`);
  if (i < 0) return null;
  segs[offset + i] = encodeURIComponent(value);
  return origin + segs.join('/') + (trailing ? '/' : '') + rest;
}

// ---- cases
let seq = 0;
const mk = (group, where, label, expect, mutate) => ({ id: `c${++seq}`, group, where, label, expect, mutate });

function bodyCases(root, schema, wire, opts) {
  const out = [];
  const s = deref(root, schema) || {};
  let json; try { json = JSON.parse(wire.body); } catch { return out; }
  out.push(mk('body', 'body', 'malformed JSON', 'reject', (w) => ({ ...w, body: (w.body || '{').slice(0, Math.max(1, Math.floor((w.body || '{').length / 2))) + '"' })));
  if (typeOf(s) === 'object') out.push(mk('body', 'body', 'an array instead of an object', 'reject', (w) => ({ ...w, body: '[]' })));
  if (typeOf(s) === 'object' && s.additionalProperties === false) out.push(mk('body', 'body', 'an unknown extra field', 'reject', (w) => setJson(w, [], (j) => ({ ...j, unexpectedField: 'x' }))));
  const walk = (node, value, keys, depth) => {
    const sch = deref(root, node) || {};
    const t = typeOf(sch);
    if (t === 'object' && value && typeof value === 'object' && !Array.isArray(value) && depth < 3) {
      const required = new Set(sch.required || []);
      for (const [k, ps] of Object.entries(sch.properties || {})) {
        const p = deref(root, ps) || {};
        if (p.readOnly) continue;
        const path = [...keys, k], where = path.reduce(keyPath, 'body');
        if (required.has(k) && k in value) out.push(mk('body', where, 'missing required field', 'reject', (w) => setJson(w, path, (j) => editAt(j, path, (n, last) => { delete n[last]; }))));
        if (!(k in value)) continue;
        walk(p, value[k], path, depth + 1);
      }
      return;
    }
    if (!keys.length) return;
    const where = keys.reduce(keyPath, 'body');
    const set = (v) => (w) => setJson(w, keys, (j) => editAt(j, keys, (n, last) => { n[last] = rawNumber(v); }));
    const wt = wrongType(t);
    if (wt) out.push(mk('body', where, `wrong type (${wt[1]})`, 'reject', set(wt[0])));
    if (!nullable(sch) && t) out.push(mk('body', where, 'null', 'reject', set(null)));
    if (t === 'array') {
      if (sch.minItems > 0) out.push(mk('body', where, `fewer than minItems ${sch.minItems}`, 'reject', set([])));
      if (sch.maxItems != null && Array.isArray(value) && value.length) out.push(mk('body', where, `more than maxItems ${sch.maxItems}`, 'reject', set(Array(sch.maxItems + 1).fill(value[0]))));
      if (Array.isArray(value) && value.length) walk(sch.items, value[0], [...keys, 0], depth + 1);
      return;
    }
    for (const c of scalarCases(sch, opts)) out.push(mk('body', where, c.label, c.expect, set(c.value)));
  };
  walk(schema, json, [], 0);
  return out;
}

function paramCases(root, op, wire, pathParams, opts) {
  const out = [];
  for (const prm of op.parameters || []) {
    const s = deref(root, prm.schema) || {};
    const where = `${prm.in}.${prm.name}`;
    if (prm.in === 'query') {
      if (prm.required) out.push(mk('query', where, 'missing required parameter', 'reject', (w) => ({ ...w, url: withQuery(w.url, prm.name, null) })));
      const set = (v) => (w) => ({ ...w, url: withQuery(w.url, prm.name, String(v)) });
      const wt = typeOf(s) && !['string', 'array', 'object'].includes(typeOf(s)) ? wrongType(typeOf(s)) : null;
      if (wt) out.push(mk('query', where, `wrong type (${wt[1]})`, 'reject', set(wt[0])));
      for (const c of scalarCases(s, { ...opts, asString: true, oversized: false })) out.push(mk('query', where, c.label, c.expect, set(c.value)));
    } else if (prm.in === 'path' && pathParams && op.path.includes(`{${prm.name}}`)) {
      const set = (v) => (w) => ({ ...w, url: withPathParam(w.url, op.path, prm.name, String(v)) || w.url });
      const t = typeOf(s);
      if (t === 'integer' || t === 'number') out.push(mk('path', where, 'wrong type (text)', 'reject', set('abc')));
      for (const c of scalarCases(s, { asString: true, oversized: false })) if (c.label !== 'empty string' && !/control|whitespace/.test(c.label)) out.push(mk('path', where, c.label, c.expect, set(c.value)));
      out.push(mk('path', where, 'an id that does not exist', 'reject', set(t === 'integer' || t === 'number' ? '2147483646' : 'does-not-exist-0000')));
    } else if (prm.in === 'header' && !/^(accept|content-type|authorization)$/i.test(prm.name)) {
      const key = headerKey(wire.headers, prm.name);
      if (prm.required && key) out.push(mk('header', where, 'missing required header', 'reject', (w) => { const h = { ...w.headers }; delete h[headerKey(h, prm.name)]; return { ...w, headers: h }; }));
      const set = (v) => (w) => { const h = { ...w.headers }; const k = headerKey(h, prm.name); if (k) delete h[k]; h[k || prm.name] = String(v); return { ...w, headers: h }; };
      for (const c of scalarCases(s, { asString: true, oversized: false })) if (!/control|unicode/.test(c.label)) out.push(mk('header', where, c.label, c.expect, set(c.value)));
    }
  }
  return out;
}

// No credentials, when the operation needs them and the request sends them.
function authCases(analysis, op, wire) {
  const reqs = op.security ?? analysis.security;
  if (!reqs?.length || reqs.some((r) => !Object.keys(r).length)) return [];
  const out = [];
  const names = new Set(), queryNames = new Set();
  for (const r of reqs) for (const n of Object.keys(r)) {
    const scheme = deref(analysis.doc, analysis.securitySchemes[n]);
    if (scheme?.type === 'apiKey' && scheme.in === 'header') names.add(scheme.name.toLowerCase());
    else if (scheme?.type === 'apiKey' && scheme.in === 'query') queryNames.add(scheme.name);
    else if (scheme?.type === 'apiKey' && scheme.in === 'cookie') names.add('cookie');
    else names.add('authorization');
  }
  const present = Object.keys(wire.headers).filter((k) => names.has(k.toLowerCase()));
  const presentQuery = [...queryNames].filter((q) => new RegExp(`[?&]${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=`).test(wire.url));
  if (!present.length && !presentQuery.length) return out;
  out.push(mk('auth', 'auth', 'no credentials', 'auth', (w) => {
    const h = Object.fromEntries(Object.entries(w.headers).filter(([k]) => !names.has(k.toLowerCase())));
    return { ...w, headers: h, url: presentQuery.reduce((u, q) => withQuery(u, q, null), w.url) };
  }));
  if (present.some((k) => k.toLowerCase() === 'authorization') && /^Bearer\s/i.test(wire.headers[headerKey(wire.headers, 'authorization')])) {
    out.push(mk('auth', 'auth', 'an invalid bearer token', 'auth', (w) => ({ ...w, headers: { ...w.headers, [headerKey(w.headers, 'authorization')]: 'Bearer invalid.token.value' } })));
  }
  return out;
}

// All cases for one operation, given the request as it's sent (wire, variables resolved) and its path params.
// opts: { oversized: 64 KB strings (else 5,000 characters), max: cases per operation }
export function fuzzCases(analysis, op, wire, pathParams, { oversized = true, max = 80 } = {}) {
  const root = analysis.doc, out = [];
  out.push(...authCases(analysis, op, wire));
  out.push(...paramCases(root, op, wire, pathParams, { oversized }));
  const rb = op.requestBody;
  if (rb) {
    const ct = wire.headers[headerKey(wire.headers, 'content-type')] || '';
    const media = pickMedia(rb.content, ct) || (rb.content && Object.entries(rb.content).map(([mediaType, m]) => ({ mediaType, ...m }))[0]);
    if (rb.required && (wire.body || wire.bodyParts || wire.bodyFile)) out.push(mk('body', 'body', 'no body', 'reject', (w) => { const { bodyParts, bodyFile, ...rest } = w; return { ...rest, body: '' }; }));
    if (media && isJsonMedia(media.mediaType) && wire.body && media.schema) {
      out.push(...bodyCases(root, media.schema, wire, { oversized }));
      if (ct) out.push(mk('header', 'header.Content-Type', 'wrong Content-Type (text/plain)', 'reject', (w) => ({ ...w, headers: { ...w.headers, [headerKey(w.headers, 'content-type')]: 'text/plain' } })));
    }
  }
  // Keep a spread: no more than a third of the cases on any one field, then the first `max`.
  const perWhere = new Map(), cap = Math.max(4, Math.ceil(max / 3));
  return out.filter((c) => { const n = (perWhere.get(c.where) || 0) + 1; perWhere.set(c.where, n); return n <= cap; }).slice(0, max);
}

// → { verdict, issues: spec problems with the response }
export function judgeCase(c, res, analysis, op) {
  if (!res || res.error) return { verdict: 'no-response', issues: [] };
  const issues = analysis && op ? validateResponse(analysis, op, res).filter((i) => i.level === 'error' || i.where === 'status') : [];
  if (res.status >= 500) return { verdict: 'server-error', issues };
  if (c.expect === 'auth' && res.status !== 401 && res.status !== 403) return { verdict: res.status < 400 ? 'auth-open' : 'ok', issues };
  if (c.expect === 'reject' && res.status < 400) return { verdict: 'accepted', issues };
  return { verdict: issues.length ? 'off-spec' : 'ok', issues };
}

// → { cases, ok, fail, warn, byVerdict: { verdict: n } }
export function fuzzSummary(results) {
  const byVerdict = {};
  for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
  const count = (level) => results.filter((r) => VERDICTS[r.verdict]?.level === level).length;
  return { cases: results.length, ok: count('pass'), fail: count('fail'), warn: count('warn'), byVerdict };
}
