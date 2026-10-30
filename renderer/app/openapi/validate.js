// Checking a request (as it would be sent) and its response against an operation.
// Issues: [{ level: 'error' | 'warning', where: 'query.limit' | 'body.items[0].id' | 'status' | …, message }]
import { deref } from './spec.js';
import { validateSchema, typeOf } from './schema.js';

const headerGet = (headers, name) => Object.entries(headers || {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const mediaBase = (ct) => (ct || '').split(';')[0].trim().toLowerCase();
export const isJsonMedia = (mt) => /(^|[/+])json($|;)/i.test(mt) || mt === '*/*';

// The documented media type matching a Content-Type: exact, then type/*, then */*.
export function pickMedia(content, contentType) {
  const entries = Object.entries(content || {});
  const want = mediaBase(contentType);
  const hit = entries.find(([mt]) => mediaBase(mt) === want)
    || entries.find(([mt]) => { const m = mediaBase(mt); return m.endsWith('/*') && want.startsWith(m.slice(0, -1)); })
    || entries.find(([mt]) => mediaBase(mt) === '*/*');
  return hit ? { mediaType: hit[0], ...hit[1] } : null;
}

// ---- parameter values (always strings on the wire) → typed values for schema checks
function coerceScalar(schema, raw) {
  const type = [].concat(schema?.type || [])[0];
  if (type === 'integer' && /^-?\d+$/.test(raw)) return Number(raw);
  if (type === 'number' && raw.trim() !== '' && !isNaN(Number(raw))) return Number(raw);
  if (type === 'boolean' && (raw === 'true' || raw === 'false')) return raw === 'true';
  if (type === 'null' && raw === '') return null;
  return raw;
}

const DELIMS = { form: ',', simple: ',', spaceDelimited: ' ', pipeDelimited: '|', tabDelimited: '\t' };

// values: every occurrence of the parameter (query params can repeat).
export function coerceParam(root, param, values) {
  const schema = deref(root, param.schema) || {};
  if ([].concat(schema.type || []).includes('array')) {
    const items = deref(root, schema.items) || {};
    const parts = param.explode && values.length > 1 ? values : values.flatMap((v) => v.split(DELIMS[param.style] || ','));
    return parts.filter((p) => p !== '').map((p) => coerceScalar(items, p));
  }
  return coerceScalar(schema, values[values.length - 1]);
}

function queryMap(url) {
  const map = new Map();
  const q = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0] : '';
  for (const pair of q.split('&').filter(Boolean)) {
    const ix = pair.indexOf('=');
    const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
    const k = dec(ix < 0 ? pair : pair.slice(0, ix)), v = ix < 0 ? '' : dec(pair.slice(ix + 1));
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  }
  return map;
}

const cookieMap = (header) => new Map((header || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), [c.slice(i + 1)]]; }));

// Header parameters named Accept / Content-Type / Authorization are ignored by OpenAPI (described elsewhere).
const RESERVED_HEADERS = new Set(['accept', 'content-type', 'authorization']);

const schemaIssues = (schema, value, root, mode, where) =>
  validateSchema(schema, value, { root, mode, path: where }).map((e) => ({ level: 'error', where: e.path, message: e.message }));

// ---- request
// wire: { method, url, headers, body } as built by http.js buildRequest (variables resolved).
// pathParams: from matching the URL (null when the URL doesn't fit the operation's path).
export function validateRequest(analysis, op, wire, pathParams) {
  const root = analysis.doc, issues = [];
  const add = (level, where, message) => issues.push({ level, where, message });
  const query = queryMap(wire.url);
  const cookies = cookieMap(headerGet(wire.headers, 'cookie'));

  if (!pathParams) add('error', 'path', `URL path doesn't fit ${op.path}`);
  if (op.deprecated) add('warning', 'operation', 'is deprecated');

  for (const p of op.parameters) {
    const where = `${p.in}.${p.name}`;
    let values;
    if (p.in === 'path') { if (!pathParams) continue; values = pathParams[p.name] !== undefined ? [pathParams[p.name]] : null; }
    else if (p.in === 'query') values = query.get(p.name) || null;
    else if (p.in === 'header') { if (RESERVED_HEADERS.has(p.name.toLowerCase())) continue; const h = headerGet(wire.headers, p.name); values = h === undefined ? null : [h]; }
    else if (p.in === 'cookie') values = cookies.get(p.name) || null;
    else continue;
    if (!values) { if (p.required) add('error', where, 'is required'); continue; }
    if (p.in === 'path' && /^\{\{.*\}\}$/.test(values[0])) { add('warning', where, `is the unresolved variable ${values[0]}`); continue; }
    issues.push(...schemaIssues(p.schema, coerceParam(root, p, values), root, 'request', where));
  }
  const declared = new Set(op.parameters.filter((p) => p.in === 'query').map((p) => p.name));
  for (const k of query.keys()) if (!declared.has(k)) add('warning', `query.${k}`, 'is not a documented parameter');

  issues.push(...validateRequestBody(root, op, wire));
  issues.push(...checkSecurity(analysis, op, wire, query, cookies));
  return issues;
}

function validateRequestBody(root, op, wire) {
  const issues = [], rb = op.requestBody;
  const hasBody = !!wire.body;
  if (!rb) return hasBody ? [{ level: 'warning', where: 'body', message: 'is sent but the operation takes no request body' }] : [];
  if (!hasBody) return rb.required ? [{ level: 'error', where: 'body', message: 'is required' }] : [];
  const ct = headerGet(wire.headers, 'content-type') || '';
  const media = pickMedia(rb.content, ct);
  if (!media) {
    return [{ level: 'error', where: 'header.Content-Type', message: `${ct ? `"${mediaBase(ct)}"` : '(none)'} is not accepted; expected ${Object.keys(rb.content).join(', ') || 'no body'}` }];
  }
  let value;
  if (isJsonMedia(mediaBase(ct) || media.mediaType)) {
    try { value = JSON.parse(wire.body); } catch (e) { return [{ level: 'error', where: 'body', message: `is not valid JSON (${e.message})` }]; }
  } else if (/x-www-form-urlencoded/.test(media.mediaType)) {
    const props = deref(root, media.schema)?.properties || {};
    value = {};
    for (const [k, vs] of queryMap('?' + wire.body)) value[k] = coerceParam(root, { schema: props[k] || {}, style: 'form', explode: true }, vs);
  } else return issues; // XML, text, binary: only the content type is checked
  if (media.schema) issues.push(...schemaIssues(media.schema, value, root, 'request', 'body'));
  return issues;
}

// Warn when none of the operation's alternative security requirements is satisfied by the request.
function checkSecurity(analysis, op, wire, query, cookies) {
  const reqs = op.security ?? analysis.security;
  if (!reqs?.length || reqs.some((r) => !Object.keys(r).length)) return []; // [] or an empty alternative = no auth needed
  const auth = headerGet(wire.headers, 'authorization') || '';
  const satisfied = (name) => {
    const scheme = deref(analysis.doc, analysis.securitySchemes[name]);
    if (!scheme) return true;
    if (scheme.type === 'apiKey') return scheme.in === 'query' ? query.has(scheme.name) : scheme.in === 'cookie' ? cookies.has(scheme.name) : headerGet(wire.headers, scheme.name) !== undefined;
    if (scheme.type === 'basic' || (scheme.type === 'http' && /^basic$/i.test(scheme.scheme))) return /^Basic\s/i.test(auth);
    if (scheme.type === 'http') return new RegExp(`^${scheme.scheme}\\s`, 'i').test(auth);
    return /^Bearer\s/i.test(auth); // oauth2, openIdConnect
  };
  if (reqs.some((r) => Object.keys(r).every(satisfied))) return [];
  return [{ level: 'warning', where: 'auth', message: `no credentials for ${reqs.map((r) => Object.keys(r).join(' + ')).join(' or ')}` }];
}

// ---- response
// Status lookup: exact code, then range ('4XX'), then 'default'.
export function responseFor(op, status) {
  const code = String(status);
  return op.responses[code] || op.responses[`${code[0]}XX`] || op.responses[`${code[0]}xx`] || op.responses.default || null;
}

export function validateResponse(analysis, op, res) {
  const root = analysis.doc, issues = [];
  const documented = responseFor(op, res.status);
  if (!documented) return [{ level: 'warning', where: 'status', message: `${res.status} is not documented (documented: ${Object.keys(op.responses).join(', ') || 'none'})` }];
  const content = documented.content || {};
  if (!Object.keys(content).length || !res.body) return issues;
  const ct = headerGet(res.headers, 'content-type') || '';
  const media = pickMedia(content, ct);
  if (!media) return [{ level: 'warning', where: 'header.Content-Type', message: `"${mediaBase(ct) || '(none)'}" is not documented for ${res.status}; expected ${Object.keys(content).join(', ')}` }];
  if (!media.schema || !isJsonMedia(mediaBase(ct) || media.mediaType)) return issues;
  let value;
  try { value = JSON.parse(res.body); } catch (e) { return [{ level: 'error', where: 'body', message: `is not valid JSON (${e.message})` }]; }
  return schemaIssues(media.schema, value, root, 'response', 'body');
}

export { typeOf };
