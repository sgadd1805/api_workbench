// Swagger 2.0 and OpenAPI 3.x documents normalised into one shape, plus URL → operation matching.
//
// analyzeSpec(doc) → {
//   doc, oas: 2 | 3, is31, serverUrls: [string], basePaths: [string], securitySchemes, security,
//   operations: [Operation], byKey: Map('GET /pets/{id}' → Operation) }
// Operation: { key, method: 'GET', path, operationId, summary, description, tags, deprecated,
//   parameters: [{ name, in, required, schema, description, style, explode, example }],
//   requestBody: { required, content: { mediaType: { schema, example, examples } } } | null,
//   responses: { '200' | '2XX' | 'default': { description, content } }, security: [requirement] | null }
// Schemas keep their local $refs; resolve them with deref(root, schema).

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// ---- $ref
export function pointerGet(doc, pointer) {
  return pointer.replace(/^#\/?/, '').split('/').filter(Boolean)
    .map((s) => decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((o, k) => (o == null ? undefined : o[k]), doc);
}

// Follows a chain of local $refs. Unresolvable refs become {} (accept anything) rather than throwing.
export function deref(root, node) {
  for (let i = 0; node && typeof node === 'object' && typeof node.$ref === 'string' && i < 32; i++) {
    const target = node.$ref.startsWith('#') ? pointerGet(root, node.$ref) : undefined;
    // OpenAPI 3.1 allows siblings next to $ref (e.g. description); the target's keywords win.
    const { $ref, ...siblings } = node;
    node = target === undefined ? {} : (Object.keys(siblings).length ? { ...siblings, ...target } : target);
  }
  return node;
}

// ---- Swagger 2 → OpenAPI 3 shapes
const SCHEMA_KEYS = ['type', 'format', 'items', 'enum', 'default', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'multipleOf'];
const v2ParamSchema = (p) => Object.fromEntries(SCHEMA_KEYS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
const COLLECTION_STYLE = { csv: ['form', false], ssv: ['spaceDelimited', false], pipes: ['pipeDelimited', false], multi: ['form', true], tsv: ['tabDelimited', false] };

function v2Operation(doc, op, itemParams) {
  const consumes = op.consumes || doc.consumes || ['application/json'];
  const produces = op.produces || doc.produces || ['application/json'];
  const params = mergeParams(doc, itemParams, op.parameters);
  const parameters = [], form = { type: 'object', properties: {}, required: [] };
  let requestBody = null;
  for (const p of params) {
    if (p.in === 'body') {
      requestBody = { required: !!p.required, description: p.description, content: Object.fromEntries(consumes.map((mt) => [mt, { schema: p.schema || {} }])) };
    } else if (p.in === 'formData') {
      form.properties[p.name] = { ...v2ParamSchema(p), description: p.description };
      if (p.required) form.required.push(p.name);
    } else {
      const [style, explode] = COLLECTION_STYLE[p.collectionFormat || 'csv'];
      parameters.push({ name: p.name, in: p.in, required: !!p.required || p.in === 'path', description: p.description, schema: v2ParamSchema(p), style, explode, example: p['x-example'] });
    }
  }
  if (Object.keys(form.properties).length) {
    const mts = consumes.filter((mt) => /form/.test(mt));
    requestBody = { required: form.required.length > 0, content: Object.fromEntries((mts.length ? mts : ['application/x-www-form-urlencoded']).map((mt) => [mt, { schema: form }])) };
  }
  const responses = {};
  for (const [code, raw] of Object.entries(op.responses || {})) {
    const r = deref(doc, raw);
    responses[code] = { description: r.description, content: r.schema ? Object.fromEntries(produces.map((mt) => [mt, { schema: r.schema, example: r.examples?.[mt] }])) : {} };
  }
  return { parameters, requestBody, responses };
}

function v3Operation(doc, op, itemParams) {
  const parameters = mergeParams(doc, itemParams, op.parameters).map((p) => ({
    name: p.name, in: p.in, required: !!p.required || p.in === 'path', description: p.description,
    schema: p.schema || firstContentSchema(doc, p.content) || {},
    style: p.style || (p.in === 'query' || p.in === 'cookie' ? 'form' : 'simple'),
    explode: p.explode ?? ((p.style || (p.in === 'query' || p.in === 'cookie' ? 'form' : 'simple')) === 'form'),
    example: p.example ?? Object.values(p.examples || {})[0]?.value,
  }));
  const rb = op.requestBody && deref(doc, op.requestBody);
  const requestBody = rb ? { required: !!rb.required, description: rb.description, content: rb.content || {} } : null;
  const responses = {};
  for (const [code, raw] of Object.entries(op.responses || {})) {
    const r = deref(doc, raw);
    responses[code] = { description: r.description, content: r.content || {} };
  }
  return { parameters, requestBody, responses };
}

const firstContentSchema = (doc, content) => (content ? deref(doc, Object.values(content)[0]?.schema) : undefined);

// Operation-level parameters override path-level ones with the same name + location.
function mergeParams(doc, pathLevel = [], opLevel = []) {
  const map = new Map();
  for (const raw of [...pathLevel, ...opLevel]) { const p = deref(doc, raw); if (p?.name) map.set(p.in + ':' + p.name, p); }
  return [...map.values()];
}

function serverUrlsOf(doc) {
  if (doc.swagger) {
    const host = doc.host;
    const base = (doc.basePath || '').replace(/\/$/, '');
    return host ? (doc.schemes?.length ? doc.schemes : ['https']).map((s) => `${s}://${host}${base}`) : [base || '/'];
  }
  return (doc.servers?.length ? doc.servers : [{ url: '/' }]).map((s) =>
    s.url.replace(/\{([^}]+)\}/g, (m, name) => s.variables?.[name]?.default ?? m).replace(/\/$/, '') || '/');
}

// Path part of each server URL ('https://x/api/v1' → '/api/v1'), longest first, always ending with ''.
export function basePathsOf(serverUrls) {
  const paths = serverUrls.map((u) => {
    try { return new URL(u).pathname.replace(/\/$/, ''); } catch { return u.startsWith('/') ? u.replace(/\/$/, '') : ''; }
  });
  return [...new Set([...paths, ''])].sort((a, b) => b.length - a.length);
}

export function analyzeSpec(doc) {
  const oas = doc.swagger ? 2 : 3;
  const operations = [];
  for (const [path, rawItem] of Object.entries(doc.paths || {})) {
    const item = deref(doc, rawItem) || {};
    for (const method of HTTP_METHODS) {
      const op = item[method]; if (!op) continue;
      const shape = oas === 2 ? v2Operation(doc, op, item.parameters) : v3Operation(doc, op, item.parameters);
      operations.push({
        key: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path,
        operationId: op.operationId, summary: op.summary, description: op.description, tags: op.tags || [], deprecated: !!op.deprecated,
        security: op.security ?? null, ...shape,
      });
    }
  }
  const serverUrls = serverUrlsOf(doc);
  return {
    doc, oas, is31: oas === 3 && /^3\.1/.test(doc.openapi || ''),
    serverUrls, basePaths: basePathsOf(serverUrls),
    securitySchemes: oas === 2 ? doc.securityDefinitions || {} : doc.components?.securitySchemes || {},
    security: doc.security || [],
    operations, byKey: new Map(operations.map((o) => [o.key, o])),
  };
}

// ---- URL → operation
// '/pets/{id}.json' → /^\/pets\/([^/]+)\.json$/ with param names ['id'].
const templateCache = new Map();
function compileTemplate(path) {
  if (!templateCache.has(path)) {
    const names = [];
    const source = path.split('/').map((seg) => seg.split(/(\{[^}]+\})/).map((part) => {
      const m = /^\{([^}]+)\}$/.exec(part);
      if (m) { names.push(m[1]); return '([^/]+)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('')).join('\\/');
    templateCache.set(path, { re: new RegExp('^' + source + '$'), names, literals: path.split('/').filter((s) => s && !s.includes('{')).length });
  }
  return templateCache.get(path);
}

// The path of a request URL (no query/hash), whether absolute or relative.
export function urlPath(url) {
  try { return new URL(url).pathname; } catch { return (url.split(/[?#]/)[0] || '/').replace(/^[a-z]+:\/\/[^/]+/i, '') || '/'; }
}

// → { pathParams } when `path` (a request path below the server base) fits the template.
export function matchTemplate(template, path) {
  const t = compileTemplate(template);
  const m = t.re.exec(path);
  if (!m) return null;
  const pathParams = {};
  t.names.forEach((n, i) => { try { pathParams[n] = decodeURIComponent(m[i + 1]); } catch { pathParams[n] = m[i + 1]; } });
  return { pathParams };
}

// Best operation for method + URL across the spec's server base paths: the template with the most
// literal segments wins, so /pets/mine beats /pets/{id}. → { op, pathParams } | null
export function matchOperation(analysis, method, url) {
  const path = urlPath(url).replace(/\/$/, '') || '/';
  let best = null;
  for (const base of analysis.basePaths) {
    if (base && !(path === base || path.startsWith(base + '/'))) continue;
    const rest = path.slice(base.length) || '/';
    for (const op of analysis.operations) {
      if (op.method !== method.toUpperCase()) continue;
      const m = matchTemplate(op.path.replace(/\/$/, '') || '/', rest);
      if (!m) continue;
      const score = compileTemplate(op.path).literals * 1000 + base.length;
      if (!best || score > best.score) best = { op, pathParams: m.pathParams, score, base };
    }
  }
  return best && { op: best.op, pathParams: best.pathParams, base: best.base };
}

// Path params for a known operation (when the request is explicitly linked to it). null = URL doesn't fit.
export function pathParamsFor(analysis, op, url) {
  const path = urlPath(url).replace(/\/$/, '') || '/';
  for (const base of analysis.basePaths) {
    if (base && !(path === base || path.startsWith(base + '/'))) continue;
    const m = matchTemplate(op.path.replace(/\/$/, '') || '/', path.slice(base.length) || '/');
    if (m) return m.pathParams;
  }
  return null;
}
