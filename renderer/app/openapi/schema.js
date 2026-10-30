// JSON Schema validation for OpenAPI schemas (the 3.0 / Swagger dialect, plus 3.1's type arrays,
// const and numeric exclusiveMinimum/Maximum).
//
// validateSchema(schema, value, { root, mode }) → [{ path, message }]
//   root: the whole spec document, for local $refs
//   mode: 'request' | 'response' — readOnly properties may not be sent in requests and needn't be
//         sent when "required"; writeOnly ones may not appear in responses.
import { deref } from './spec.js';

const MAX_DEPTH = 64;

const FORMATS = {
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/.test(s) && !isNaN(Date.parse(s)),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s),
  time: (s) => /^\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/.test(s),
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  uri: (s) => /^[a-z][a-z0-9+.-]*:\S*$/i.test(s),
  url: (s) => /^[a-z][a-z0-9+.-]*:\S*$/i.test(s),
  ipv4: (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s),
  ipv6: (s) => s.includes(':') && (() => { try { new URL(`http://[${s}]`); return true; } catch { return false; } })(),
  byte: (s) => /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0,
};
const INT_RANGE = { int32: [-(2 ** 31), 2 ** 31 - 1], int64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] };

export function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v; // string, boolean, object, undefined
}
const fitsType = (t, v) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);

const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'string' ? `"${v.length > 40 ? v.slice(0, 40) + '…' : v}"` : typeof v === 'object' ? 'object' : String(v));
const join = (path, key) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function validateSchema(schema, value, opts) {
  const errors = [];
  check(schema, value, opts.path || '', { root: opts.root, mode: opts.mode || 'request' }, errors, 0);
  return errors;
}

function check(rawSchema, value, at, ctx, errors, depth) {
  if (depth > MAX_DEPTH || rawSchema === undefined || rawSchema === true) return;
  if (rawSchema === false) { errors.push({ path: at, message: 'is not allowed' }); return; }
  const s = deref(ctx.root, rawSchema);
  if (!s || typeof s !== 'object') return;
  const err = (message) => errors.push({ path: at, message });

  const types = s.type === undefined ? null : [].concat(s.type);
  if (value === null) {
    if (s.nullable || s['x-nullable'] || types?.includes('null') || s.enum?.includes(null) || s.const === null) return;
    if (types) { err(`must not be null (expected ${types.join(' | ')})`); return; }
  }

  // Composition
  for (const sub of s.allOf || []) check(sub, value, at, ctx, errors, depth + 1);
  if (s.anyOf) {
    const results = s.anyOf.map((sub) => sub && validateBranch(sub, value, at, ctx, depth));
    if (!results.some((r) => r.length === 0)) err(`does not match any of the ${s.anyOf.length} allowed schemas${closest(results)}`);
  }
  if (s.oneOf) {
    const branch = discriminated(s, value, ctx);
    if (branch) check(branch, value, at, ctx, errors, depth + 1);
    else {
      const results = s.oneOf.map((sub) => validateBranch(sub, value, at, ctx, depth));
      const passing = results.filter((r) => r.length === 0).length;
      if (passing === 0) err(`does not match any of the ${s.oneOf.length} oneOf schemas${closest(results)}`);
      else if (passing > 1) err(`matches ${passing} of the oneOf schemas (must match exactly one)`);
    }
  }
  if (s.not && validateBranch(s.not, value, at, ctx, depth).length === 0) err('matches a schema it must not match');

  if (types && !types.some((t) => fitsType(t, value))) { err(`expected ${types.join(' | ')}, got ${describe(value)}`); return; }
  if (s.enum && !s.enum.some((e) => deepEqual(e, value))) err(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (s.const !== undefined && !deepEqual(s.const, value)) err(`must be ${JSON.stringify(s.const)}`);

  switch (typeOf(value)) {
    case 'string': checkString(s, value, err); break;
    case 'integer': case 'number': checkNumber(s, value, err); break;
    case 'array': checkArray(s, value, at, ctx, errors, depth, err); break;
    case 'object': checkObject(s, value, at, ctx, errors, depth, err); break;
  }
}

const validateBranch = (schema, value, at, ctx, depth) => { const e = []; check(schema, value, at, ctx, e, depth + 1); return e; };

// For anyOf/oneOf failures, show the reasons from the branch that came closest.
function closest(results) {
  const best = results.filter(Boolean).sort((a, b) => a.length - b.length)[0];
  return best?.length ? ` (closest: ${best[0].path ? best[0].path + ' ' : ''}${best[0].message})` : '';
}

// oneOf + discriminator: pick the branch named by the discriminator property instead of trying all.
function discriminated(s, value, ctx) {
  const prop = s.discriminator?.propertyName;
  if (!prop || typeOf(value) !== 'object' || typeof value[prop] !== 'string') return null;
  const name = value[prop];
  const ref = s.discriminator.mapping?.[name];
  if (ref) return { $ref: ref.startsWith('#') ? ref : `#/components/schemas/${ref}` };
  return s.oneOf.find((sub) => typeof sub?.$ref === 'string' && sub.$ref.split('/').pop() === name) || null;
}

function checkString(s, v, err) {
  const len = [...v].length;
  if (s.minLength !== undefined && len < s.minLength) err(`must be at least ${s.minLength} characters (got ${len})`);
  if (s.maxLength !== undefined && len > s.maxLength) err(`must be at most ${s.maxLength} characters (got ${len})`);
  if (s.pattern) { try { if (!new RegExp(s.pattern, 'u').test(v)) err(`must match pattern ${s.pattern}`); } catch {} }
  if (s.format && FORMATS[s.format] && !FORMATS[s.format](v)) err(`is not a valid ${s.format}`);
}

function checkNumber(s, v, err) {
  // 3.0 / Swagger: exclusiveMinimum is a boolean modifying minimum; 3.1: it's the bound itself.
  if (s.minimum !== undefined && (s.exclusiveMinimum === true ? v <= s.minimum : v < s.minimum)) err(`must be ${s.exclusiveMinimum === true ? '>' : '≥'} ${s.minimum}`);
  if (s.maximum !== undefined && (s.exclusiveMaximum === true ? v >= s.maximum : v > s.maximum)) err(`must be ${s.exclusiveMaximum === true ? '<' : '≤'} ${s.maximum}`);
  if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) err(`must be > ${s.exclusiveMinimum}`);
  if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) err(`must be < ${s.exclusiveMaximum}`);
  if (s.multipleOf && Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9) err(`must be a multiple of ${s.multipleOf}`);
  const range = INT_RANGE[s.format];
  if (range && Number.isInteger(v) && (v < range[0] || v > range[1])) err(`is out of range for ${s.format}`);
  if (s.format && INT_RANGE[s.format] && !Number.isInteger(v)) err(`must be an integer (${s.format})`);
}

function checkArray(s, v, at, ctx, errors, depth, err) {
  if (s.minItems !== undefined && v.length < s.minItems) err(`must have at least ${s.minItems} items (got ${v.length})`);
  if (s.maxItems !== undefined && v.length > s.maxItems) err(`must have at most ${s.maxItems} items (got ${v.length})`);
  if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) err('must not contain duplicate items');
  const tuple = s.prefixItems || (Array.isArray(s.items) ? s.items : null);
  v.forEach((item, i) => {
    const sub = tuple ? (i < tuple.length ? tuple[i] : s.prefixItems ? s.items : s.additionalItems) : s.items;
    if (sub !== undefined) check(sub, item, join(at, i), ctx, errors, depth + 1);
  });
}

function checkObject(s, v, at, ctx, errors, depth, err) {
  const props = s.properties || {};
  const keys = Object.keys(v);
  const propSchema = (k) => deref(ctx.root, props[k]) || {};
  for (const k of s.required || []) {
    if (k in v) continue;
    const ps = propSchema(k);
    if ((ctx.mode === 'request' && ps.readOnly) || (ctx.mode === 'response' && ps.writeOnly)) continue;
    errors.push({ path: join(at, k), message: 'is required' });
  }
  for (const k of keys) {
    if (k in props) {
      const ps = propSchema(k);
      if (ctx.mode === 'request' && ps.readOnly) errors.push({ path: join(at, k), message: 'is read-only and should not be sent' });
      if (ctx.mode === 'response' && ps.writeOnly) errors.push({ path: join(at, k), message: 'is write-only and should not be returned' });
      check(props[k], v[k], join(at, k), ctx, errors, depth + 1);
      continue;
    }
    const pattern = Object.entries(s.patternProperties || {}).find(([re]) => { try { return new RegExp(re, 'u').test(k); } catch { return false; } });
    if (pattern) { check(pattern[1], v[k], join(at, k), ctx, errors, depth + 1); continue; }
    if (s.additionalProperties === false) errors.push({ path: join(at, k), message: 'is not a known property' });
    else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, v[k], join(at, k), ctx, errors, depth + 1);
  }
  if (s.minProperties !== undefined && keys.length < s.minProperties) err(`must have at least ${s.minProperties} properties`);
  if (s.maxProperties !== undefined && keys.length > s.maxProperties) err(`must have at most ${s.maxProperties} properties`);
}
