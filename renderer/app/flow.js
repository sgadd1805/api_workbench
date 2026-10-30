// Captured login-window calls → requests that keep working after the capture (Session toolbar → Network).
//
// templatize: the scheme + host become an environment variable ({{baseUrl}}), browser noise headers are
//   dropped, and a captured "Authorization: Bearer …" becomes the request's bearer auth with {{token}} (a
//   secret variable holding the captured value) — or is dropped when the project already sends auth.
// buildFlow: several calls in capture order, with the values that pass between them linked: a token, id or
//   CSRF value in an earlier response that a later request sends gets an extract rule on the earlier
//   request and a {{variable}} in the later one, so the folder replays in the collection runner.
import { requestFromCapture } from './capture.js';

// Headers the browser adds that a replay shouldn't copy (the app sets its own, or they pin the capture).
const NOISE = /^(sec-.*|user-agent|accept-language|accept-encoding|origin|referer|cookie|priority|dnt|pragma|cache-control|upgrade-insecure-requests|x-client-data)$/i;

const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };
const camel = (s) => String(s).replace(/[^A-Za-z0-9]+(.)?/g, (_m, c) => (c ? c.toUpperCase() : '')).replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/^(\d)/, '_$1');
const free = (name, taken) => { let n = name; for (let i = 2; taken.has(n); i++) n = name + i; return n; };
const unique = (name, taken) => { const n = free(name, taken); taken.add(n); return n; };
const hasAuth = (a) => !!a && a.type !== 'none' && a.type !== 'inherit' && (a.type !== 'bearer' || !!a.token);

// A variable for each origin: an existing variable whose value the URL starts with is reused (it may include a
// path such as /api/v1), else baseUrl, then <first host label>Url (authUrl, apiUrl …).
// → { names: Map(origin → { name, prefix }), newVars: { name: origin } }
export function originVars(urls, vars = {}) {
  const names = new Map(), newVars = {}, taken = new Set(Object.keys(vars));
  for (const url of urls) {
    const origin = originOf(url); if (!origin || names.has(origin)) continue;
    const hit = Object.entries(vars).map(([k, v]) => [k, String(v ?? '').replace(/\/+$/, '')])
      .filter(([, v]) => /^https?:\/\//i.test(v) && v.startsWith(origin) && (url === v || url.startsWith(v + '/') || url.startsWith(v + '?')))
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (hit) { names.set(origin, { name: hit[0], prefix: hit[1] }); continue; }
    let name = 'baseUrl';
    if (taken.has(name)) { const label = new URL(origin).hostname.split('.')[0]; name = camel(/^\d+$/.test(label) || label === 'localhost' ? 'local' : label) + 'Url'; }
    name = unique(name, taken);
    newVars[name] = origin;
    names.set(origin, { name, prefix: origin });
  }
  return { names, newVars };
}

// The URL prefix as {{var}} and noise headers dropped; the captured bearer token is returned, not handled.
function baseTemplate(summary, origins) {
  const req = requestFromCapture(summary);
  const o = origins.get(originOf(req.url));
  if (o && req.url.startsWith(o.prefix)) req.url = `{{${o.name}}}` + req.url.slice(o.prefix.length);
  req.headers = req.headers.filter((h) => !NOISE.test(h.k));
  const auth = req.headers.find((h) => /^authorization$/i.test(h.k));
  const bearer = auth && /^Bearer\s+(\S+)$/i.exec(auth.v)?.[1];
  if (bearer) req.headers = req.headers.filter((h) => h !== auth);
  return { req, bearer: bearer || null };
}

// The captured bearer token as the request's auth: a linked variable, else {{token}} (a secret holding the
// captured value), or nothing when the project's own auth covers it.
function applyBearer(req, bearer, { linkedName, keepAuth, secret }) {
  if (!bearer) return;
  if (linkedName) req.auth = { type: 'bearer', token: `{{${linkedName}}}` };
  else if (!keepAuth) { secret.value ??= bearer; req.auth = { type: 'bearer', token: secret.value === bearer ? `{{${secret.name}}}` : bearer }; }
}

// One captured call (main/har.js summary) as a templatized request. vars: the active environment's variables;
// projectAuth: the project's auth. → { req, newVars: { name: value }, secretVars: { name: value } }
export function templatize(summary, { vars = {}, projectAuth = null } = {}) {
  const { names, newVars } = originVars([summary.url], vars);
  const { req, bearer } = baseTemplate(summary, names);
  const secret = { name: unique('token', new Set([...Object.keys(vars).filter((k) => k !== 'token'), ...Object.keys(newVars)])), value: undefined };
  applyBearer(req, bearer, { keepAuth: hasAuth(projectAuth), secret });
  return { req, newVars, secretVars: secret.value ? { [secret.name]: secret.value } : {} };
}

// ---- values passed between calls

// Worth linking: an id, token or key rather than a word or a small number (6+ characters, or 4+ with a digit).
const linkable = (v) => (typeof v === 'string' ? (v.length >= 6 || (v.length >= 4 && /\d/.test(v))) && !/^(true|false|null)$/i.test(v)
  : typeof v === 'number' && Number.isInteger(v) && Math.abs(v) >= 100);
const LINKABLE_HEADER = /(token|csrf|xsrf|session|request-id|correlation|location|etag|key)/i;

function leaves(v, path = [], out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => leaves(x, [...path, String(i)], out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) leaves(x, [...path, k], out);
  else out.push([path, v]);
  return out;
}

// Values a response hands out: JSON leaves and a few headers. → [{ path (extract rule syntax), value, key }]
export function produced(detail) {
  const out = [];
  let json; try { json = JSON.parse(detail?.response?.body ?? ''); } catch { /* not JSON */ }
  if (json !== undefined) for (const [path, v] of leaves(json)) if (path.length && linkable(v)) out.push({ path: path.join('.'), value: String(v), key: path });
  for (const [h, v] of Object.entries(detail?.response?.headers || {})) {
    if (LINKABLE_HEADER.test(h) && !/^set-cookie$/i.test(h) && typeof v === 'string' && v.length >= 6) out.push({ path: `header.${h.toLowerCase()}`, value: v, key: [h.toLowerCase()] });
  }
  return out;
}

// A variable name for a value at `key` in the response to `url`: the last named key, with "id" qualified by its
// parent key or the URL's resource (POST /orders → { id } → orderId).
function nameFor(key, url) {
  const named = key.filter((k) => !/^\d+$/.test(k));
  let last = named.at(-1) || 'value';
  if (/^(id|uuid|key|code)$/i.test(last)) {
    let parent = named.at(-2);
    if (!parent) { try { parent = new URL(url).pathname.split('/').filter((s) => s && !/^\d+$/.test(s)).at(-1); } catch { /* no resource */ } }
    if (parent) last = `${parent.replace(/ies$/, 'y').replace(/(?<!s)s$/, '')} ${last}`;
  }
  return camel(last.replace(/^x-/i, '')) || 'value';
}

// Replaces `value` with `ref` where a request sends it: a whole URL path segment or query value, a header
// value, a JSON body value (numbers stay unquoted), a form field, or (8+ characters) inside a raw body.
// → true if it was found
export function useIn(req, value, ref) {
  let used = false;
  const m = /^(\{\{[^}]+\}\})?(.*)$/s.exec(req.url);
  const prefix = m[1] || '', rest = m[2];
  const qAt = rest.indexOf('?'), hashAt = rest.indexOf('#');
  const end = hashAt < 0 ? rest.length : hashAt;
  const pathPart = qAt < 0 ? rest.slice(0, end) : rest.slice(0, qAt), query = qAt < 0 ? '' : rest.slice(qAt + 1, end), hash = rest.slice(end);
  const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
  const segs = pathPart.split('/').map((s) => (s && dec(s) === value ? (used = true, ref) : s));
  const pairs = query ? query.split('&').map((pair) => { const [k, v = ''] = pair.split('='); return v && dec(v) === value ? (used = true, `${k}=${ref}`) : pair; }) : [];
  if (used) req.url = prefix + segs.join('/') + (pairs.length ? '?' + pairs.join('&') : '') + hash;
  for (const h of req.headers) if (h.v && h.v.includes(value)) { h.v = h.v.split(value).join(ref); used = true; }
  if (req.auth?.type === 'bearer' && req.auth.token === value) { req.auth.token = ref; used = true; }
  const body = req.body || {};
  if (body.type === 'json' && body.text) {
    let json, hit = false; try { json = JSON.parse(body.text); } catch { /* malformed: treated as text */ }
    if (json !== undefined) {
      const mark = `__aw${Math.random().toString(36).slice(2)}`;
      const walk = (v) => (Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
        : (typeof v === 'string' || typeof v === 'number') && String(v) === value ? (hit = true, mark + (typeof v)) : v);
      const out = walk(json);
      if (hit) { used = true; body.text = JSON.stringify(out, null, 2).split(`"${mark}number"`).join(ref).split(`${mark}string`).join(ref); }
    } else if (value.length >= 8 && body.text.includes(value)) { body.text = body.text.split(value).join(ref); used = true; }
  } else if (body.type === 'raw' && value.length >= 8 && body.text?.includes(value)) { body.text = body.text.split(value).join(ref); used = true; }
  for (const f of body.form || []) if (f.v === value) { f.v = ref; used = true; }
  return used;
}

// ---- checks from a captured response

// Fields whose values change from run to run: only their type is checked.
const VOLATILE_WORDS = /(uuid|guid|token|secret|nonce|csrf|session|time|date|created|updated|modified|expires|expiry|version|etag|count|total|seq|random|hash|signature|url|href|link)/i;
// id, orderId, order_id, createdAt, paid_at … but not "paid" or "format".
const isVolatileKey = (k) => /^id$/i.test(k) || /[a-z0-9]Id$/.test(k) || /_id$/i.test(k) || /[a-z0-9]At$/.test(k) || /_at$/i.test(k) || VOLATILE_WORDS.test(k);
const VOLATILE_VALUE = /^\d{4}-\d{2}-\d{2}|^[0-9a-f]{8}-[0-9a-f]{4}-|^eyJ|^\d{10,}$/i;
const access = (path) => 'body' + path.map((k) => (/^\d+$/.test(k) ? `[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)).join('');
const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

// Assertions (the request's assertion language: JS over status and body) that a replay should keep
// passing: the status, the JSON shape, and fields that look stable — an "OPEN" status, a role, a flag —
// compared exactly, while ids, tokens, times, counts and other numbers only keep their type. → [string]
export function checksFor(response, { max = 12 } = {}) {
  const out = [];
  if (response?.status) out.push(`status === ${response.status}`);
  let json; try { json = JSON.parse(response?.body ?? ''); } catch { return out; }
  const visit = (v, path, depth) => {
    if (out.length >= max) return;
    const key = path.at(-1) ?? '', at = access(path), t = typeOf(v);
    if (t === 'array') {
      out.push(path.length ? `Array.isArray(${at})` : 'Array.isArray(body)');
      if (v.length) { out.push(`${at}.length > 0`); if (depth < 2 && v[0] && typeof v[0] === 'object') visit(v[0], [...path, '0'], depth + 1); }
    } else if (t === 'object') {
      if (path.length) out.push(`${at} && typeof ${at} === 'object'`);
      if (depth < 2) for (const [k, x] of Object.entries(v).slice(0, 8)) visit(x, [...path, k], depth + 1);
    } else if (t === 'null') out.push(`${at} === null`);
    else if (t === 'boolean' && !isVolatileKey(key)) out.push(`${at} === ${v}`);
    else if (t === 'string' && !isVolatileKey(key) && !VOLATILE_VALUE.test(v) && v.length <= 30 && !/\d{3,}/.test(v)) out.push(`${at} === ${JSON.stringify(v)}`);
    else out.push(`typeof ${at} === '${t}'`);
  };
  visit(json, [], 0);
  return out.slice(0, max);
}

// calls: [{ summary, detail }] in capture order (main/har.js entrySummaries / entryDetail).
// checks: add checksFor() assertions to each request from what it got back.
// vars: the active environment's variables; secretNames: which of them are secret. A linked value reuses an
// existing variable of the same name (capturing a flow again updates it, and its extract rule overwrites it on
// every run anyway), except secret variables and ones holding a URL.
// → { requests: [store request, with chain rules on the producers], links: [{ name, from, path, usedBy: [index] }],
//     newVars: { name: value } (origins and the captured values, so the flow runs as captured), secretVars }
export function buildFlow(calls, { vars = {}, projectAuth = null, secretNames = [], checks = false } = {}) {
  const { names, newVars } = originVars(calls.map((c) => c.summary.url), vars);
  const built = calls.map((c) => baseTemplate(c.summary, names));
  const requests = built.map((b) => b.req);
  // While linking, a captured bearer token is the request's auth, so it can be matched like any other value.
  built.forEach((b) => { if (b.bearer) b.req.auth = { type: 'bearer', token: b.bearer }; });
  const taken = new Set([...Object.keys(newVars), ...secretNames, ...Object.entries(vars).filter(([, v]) => /^https?:\/\//i.test(String(v))).map(([k]) => k)]);
  const links = [], byValue = new Map();
  for (let i = 1; i < calls.length; i++) {
    const done = new Set();
    // Nearest earlier response first: a value a request sends most likely came from the call just before it.
    for (let j = i - 1; j >= 0; j--) {
      for (const p of produced(calls[j].detail)) {
        if (done.has(p.value)) continue;
        let link = byValue.get(p.value);
        const name = link?.name ?? free(nameFor(p.key, calls[j].summary.url), taken);
        if (!useIn(requests[i], p.value, `{{${name}}}`)) continue;
        done.add(p.value);
        if (!link) {
          taken.add(name);
          link = { name, from: j, path: p.path, value: p.value, usedBy: [] };
          byValue.set(p.value, link); links.push(link);
          requests[j].chain = [...(requests[j].chain || []), { k: p.path, v: name, on: true }];
        }
        link.usedBy.push(i);
      }
    }
  }
  // Bearer tokens nothing earlier handed out: {{token}} (a secret with the captured value), or the project's auth.
  const secret = { name: unique('token', new Set([...taken, ...Object.keys(vars)].filter((k) => k !== 'token' || secretNames.includes('token')))), value: undefined };
  built.forEach((b, i) => {
    if (!b.bearer) return;
    const linked = /^\{\{(.+)\}\}$/.exec(requests[i].auth?.token || '')?.[1];
    requests[i].auth = { type: 'inherit' };
    if (linked) requests[i].auth = { type: 'bearer', token: `{{${linked}}}` };
    else applyBearer(requests[i], b.bearer, { keepAuth: hasAuth(projectAuth), secret });
  });
  for (const l of links) { newVars[l.name] = l.value; delete l.value; }
  if (checks) calls.forEach((c, i) => { requests[i].assertions = checksFor(c.detail?.response); });
  return { requests, links, newVars, secretVars: secret.value ? { [secret.name]: secret.value } : {} };
}
