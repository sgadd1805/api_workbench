// Example values from schemas, and saved requests from operations.
import { deref } from './spec.js';
import { isJsonMedia } from './validate.js';

const MAX_DEPTH = 8;
const STRING_FORMATS = {
  'date-time': () => new Date().toISOString().replace(/\.\d+Z$/, 'Z'), date: () => new Date().toISOString().slice(0, 10), time: () => '12:00:00Z',
  email: () => 'user@example.com', uuid: () => '00000000-0000-4000-8000-000000000000', uri: () => 'https://example.com', url: () => 'https://example.com',
  ipv4: () => '192.0.2.1', ipv6: () => '2001:db8::1', byte: () => 'ZXhhbXBsZQ==', password: () => 'secret',
};

// A plausible value for a schema: its example/default/enum when given, else one built from its type.
// readOnly properties are left out of request bodies; for responses (forResponse) writeOnly ones are.
export function exampleFor(schema, root, depth = 0, seen = new Set(), forResponse = false) {
  if (depth > MAX_DEPTH || !schema) return undefined;
  const ref = schema.$ref;
  if (ref) { if (seen.has(ref)) return undefined; seen = new Set(seen).add(ref); }
  const s = deref(root, schema);
  if (!s || typeof s !== 'object') return undefined;
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[0];
  if (s.allOf) return s.allOf.reduce((acc, sub) => { const v = exampleFor(sub, root, depth + 1, seen, forResponse); return v && typeof v === 'object' && !Array.isArray(v) ? { ...acc, ...v } : acc; }, {});
  if (s.oneOf || s.anyOf) return exampleFor((s.oneOf || s.anyOf)[0], root, depth + 1, seen, forResponse);
  const type = [].concat(s.type || (s.properties ? 'object' : s.items ? 'array' : 'string')).find((t) => t !== 'null');
  switch (type) {
    case 'object': {
      const out = {};
      for (const [k, ps] of Object.entries(s.properties || {})) {
        if (deref(root, ps)?.[forResponse ? 'writeOnly' : 'readOnly']) continue;
        const v = exampleFor(ps, root, depth + 1, seen, forResponse);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    case 'array': { const v = exampleFor(s.items, root, depth + 1, seen, forResponse); return v === undefined ? [] : [v]; }
    case 'integer': case 'number': {
      // Smallest allowed value at or above 0 (3.0's boolean exclusiveMinimum and 3.1's numeric one).
      let v = Math.max(0, s.minimum ?? 0);
      if (s.exclusiveMinimum === true && v <= s.minimum) v = s.minimum + 1;
      if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) v = s.exclusiveMinimum + 1;
      if (s.maximum !== undefined && v > s.maximum) v = s.maximum;
      return type === 'integer' ? Math.ceil(v) : v;
    }
    case 'boolean': return true;
    default: {
      const v = STRING_FORMATS[s.format]?.() ?? 'string';
      return s.minLength && v.length < s.minLength ? v.padEnd(s.minLength, 'x') : v;
    }
  }
}

export function mediaExample(media, root, forResponse = false) {
  if (media.example !== undefined) return media.example;
  const first = Object.values(media.examples || {})[0];
  if (first) return deref(root, first).value;
  return exampleFor(media.schema, root, 0, new Set(), forResponse);
}

const paramExample = (p, root) => {
  const v = p.example ?? exampleFor(p.schema, root);
  return Array.isArray(v) ? v.join(',') : v === undefined ? '' : String(v);
};

// The media type to send by default: JSON, then form, then the first listed.
export function preferredMedia(content) {
  const keys = Object.keys(content || {});
  return keys.find((k) => /json/i.test(k)) || keys.find((k) => /x-www-form-urlencoded/i.test(k)) || keys[0] || null;
}

// Body fields for a request (store.js Request.body shape) + any Content-Type header it needs.
export function bodyFor(op, root) {
  const content = op.requestBody?.content;
  const mt = preferredMedia(content);
  if (!mt) return { body: { type: 'none', text: '', form: [] }, contentType: null };
  const example = mediaExample(content[mt], root);
  if (/x-www-form-urlencoded/i.test(mt)) {
    const obj = example && typeof example === 'object' ? example : {};
    return { body: { type: 'form', text: '', form: Object.entries(obj).map(([k, v]) => ({ k, v: typeof v === 'object' ? JSON.stringify(v) : String(v), on: true })) }, contentType: null };
  }
  if (isJsonMedia(mt)) return { body: { type: 'json', text: JSON.stringify(example ?? {}, null, 2), form: [] }, contentType: /^application\/json$/i.test(mt) ? null : mt };
  return { body: { type: 'raw', text: typeof example === 'string' ? example : '', form: [] }, contentType: mt };
}

const RESERVED_HEADERS = new Set(['accept', 'content-type', 'authorization']);

// One operation → request fields (pass to store.js newReq). Path params become {{variables}};
// required query params are filled with examples, header params added (enabled when required).
export function requestFieldsFor(analysis, op, specId) {
  const root = analysis.doc;
  const query = op.parameters.filter((p) => p.in === 'query' && p.required)
    .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(paramExample(p, root))}`).join('&');
  const headers = op.parameters.filter((p) => p.in === 'header' && !RESERVED_HEADERS.has(p.name.toLowerCase()))
    .map((p) => ({ k: p.name, v: paramExample(p, root), on: !!p.required }));
  const { body, contentType } = bodyFor(op, root);
  if (contentType) headers.push({ k: 'Content-Type', v: contentType, on: true });
  return {
    name: op.summary || op.operationId || op.key,
    method: op.method,
    url: '{{baseUrl}}' + op.path.replace(/\{([^}]+)\}/g, '{{$1}}') + (query ? '?' + query : ''),
    headers, body,
    spec: { specId, opKey: op.key },
  };
}

// Variables the generated requests use: baseUrl (first server) and each path param's example.
export function variablesFor(analysis, ops) {
  const vars = [{ k: 'baseUrl', v: analysis.serverUrls[0] || '' }];
  const seen = new Set(['baseUrl']);
  for (const op of ops) for (const p of op.parameters) {
    if (p.in !== 'path' || seen.has(p.name)) continue;
    seen.add(p.name);
    vars.push({ k: p.name, v: paramExample(p, analysis.doc) });
  }
  return vars;
}

export const operationLabel = (op) => `${op.method} ${op.path}${op.summary ? ` — ${op.summary}` : ''}${op.deprecated ? ' (deprecated)' : ''}`;
