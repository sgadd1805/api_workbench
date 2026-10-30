// Breaking-change check between two versions of a spec (e.g. the attached one and an older git version).
// diffSpecs(oldDoc, newDoc) → [{ level: 'breaking' | 'warning' | 'info', op: 'GET /pets', where, message }]
// "Breaking" means an existing client could now fail: an operation or success response removed, a new
// required parameter or field, a request type / enum narrowed, a response field removed or its type changed.
import { analyzeSpec, deref } from './spec.js';
import { preferredMedia } from './generate.js';

const MAX_DEPTH = 12;
const LEVEL_ORDER = { breaking: 0, warning: 1, info: 2 };

export function diffSpecs(oldDoc, newDoc) {
  const a = analyzeSpec(oldDoc), b = analyzeSpec(newDoc);
  const out = [];
  const add = (level, op, where, message) => out.push({ level, op, where, message });
  for (const oldOp of a.operations) {
    const newOp = b.byKey.get(oldOp.key);
    if (!newOp) { add('breaking', oldOp.key, '', 'Operation removed'); continue; }
    if (!oldOp.deprecated && newOp.deprecated) add('warning', oldOp.key, '', 'Operation is now deprecated');
    diffOperation(oldOp, newOp, { a: a.doc, b: b.doc, add: (level, where, message) => add(level, oldOp.key, where, message) });
  }
  for (const op of b.operations) if (!a.byKey.has(op.key)) add('info', op.key, '', 'Operation added');
  return out.sort((x, y) => LEVEL_ORDER[x.level] - LEVEL_ORDER[y.level] || x.op.localeCompare(y.op));
}

export const summarizeDiff = (changes) => ({
  breaking: changes.filter((c) => c.level === 'breaking').length,
  warning: changes.filter((c) => c.level === 'warning').length,
  info: changes.filter((c) => c.level === 'info').length,
});

function diffOperation(o, n, ctx) {
  // Parameters, by location + name.
  const params = (op) => new Map(op.parameters.map((p) => [`${p.in}.${p.name}`, p]));
  const po = params(o), pn = params(n);
  for (const [k, p] of po) {
    const q = pn.get(k);
    if (!q) { ctx.add('warning', k, 'Parameter removed (clients still sending it may be rejected or ignored)'); continue; }
    if (!p.required && q.required) ctx.add('breaking', k, 'Parameter is now required');
    diffSchema(p.schema, q.schema, 'request', k, ctx, 0, new Set());
  }
  for (const [k, q] of pn) if (!po.has(k)) ctx.add(q.required ? 'breaking' : 'info', k, q.required ? 'New required parameter' : 'New optional parameter');

  // Request body.
  const ob = o.requestBody, nb = n.requestBody;
  if (nb?.required && !ob?.required) ctx.add('breaking', 'body', ob ? 'Request body is now required' : 'New required request body');
  if (ob && !nb) ctx.add('warning', 'body', 'Request body removed');
  if (ob && nb) {
    for (const mt of Object.keys(ob.content || {})) if (!nb.content?.[mt]) ctx.add('breaking', 'body', `No longer accepts ${mt}`);
    const mt = preferredMedia(ob.content);
    if (mt && nb.content?.[mt]) diffSchema(ob.content[mt].schema, nb.content[mt].schema, 'request', 'body', ctx, 0, new Set());
  }

  // Responses, by status code.
  for (const [code, r] of Object.entries(o.responses || {})) {
    const s = n.responses?.[code];
    if (!s) { ctx.add(/^2/.test(code) ? 'breaking' : 'warning', code, `${code} response removed`); continue; }
    for (const mt of Object.keys(r.content || {})) if (!s.content?.[mt]) ctx.add('breaking', code, `${code} no longer returns ${mt}`);
    const mt = preferredMedia(r.content);
    if (mt && s.content?.[mt]) diffSchema(r.content[mt].schema, s.content[mt].schema, 'response', `${code} body`, ctx, 0, new Set());
  }
  for (const code of Object.keys(n.responses || {})) if (!o.responses?.[code]) ctx.add(/^2/.test(code) ? 'warning' : 'info', code, `New ${code} response`);
}

// allOf merged into one object schema; $refs resolved against each document.
function flatten(root, schema, depth = 0) {
  const s = deref(root, schema);
  if (!s || typeof s !== 'object' || !s.allOf || depth > MAX_DEPTH) return s;
  const merged = { ...s, properties: { ...(s.properties || {}) }, required: [...(s.required || [])] };
  delete merged.allOf;
  for (const part of s.allOf) {
    const p = flatten(root, part, depth + 1) || {};
    Object.assign(merged.properties, p.properties || {});
    merged.required.push(...(p.required || []));
    merged.type ||= p.type;
  }
  return merged;
}

const typesOf = (s) => {
  const t = s.type ? [].concat(s.type) : s.properties ? ['object'] : s.items ? ['array'] : [];
  if (s.nullable) t.push('null');
  // integer is a subset of number
  return new Set(t);
};
const covers = (wide, narrow) => [...narrow].every((t) => wide.has(t) || (t === 'integer' && wide.has('number')));
const fmt = (set) => [...set].join(' | ') || 'any';

// dir 'request': what clients send (narrowing breaks them). dir 'response': what they receive (widening / removal breaks them).
function diffSchema(oldS, newS, dir, where, ctx, depth, seen) {
  if (!oldS || !newS || depth > MAX_DEPTH) return;
  const key = `${oldS.$ref || ''}|${newS.$ref || ''}|${dir}`;
  if ((oldS.$ref || newS.$ref) && seen.has(key)) return;
  if (oldS.$ref || newS.$ref) seen = new Set(seen).add(key);
  const o = flatten(ctx.a, oldS), n = flatten(ctx.b, newS);
  if (!o || !n || typeof o !== 'object' || typeof n !== 'object') return;
  const req = dir === 'request';

  const to = typesOf(o), tn = typesOf(n);
  if (to.size && tn.size && fmt(to) !== fmt(tn)) {
    const narrowed = !covers(tn, to), widened = !covers(to, tn);
    if (req ? narrowed : widened) ctx.add('breaking', where, `Type changed: ${fmt(to)} → ${fmt(tn)}`);
    else ctx.add('info', where, `Type ${req ? 'widened' : 'narrowed'}: ${fmt(to)} → ${fmt(tn)}`);
    if (!to.has('object') || !tn.has('object')) return;
  }
  if (o.format !== n.format && o.format && n.format) ctx.add('warning', where, `Format changed: ${o.format} → ${n.format}`);

  if (Array.isArray(o.enum) && Array.isArray(n.enum)) {
    const removed = o.enum.filter((v) => !n.enum.includes(v)), added = n.enum.filter((v) => !o.enum.includes(v));
    const list = (vs) => vs.map((v) => JSON.stringify(v)).join(', ');
    if (removed.length) ctx.add(req ? 'breaking' : 'info', where, `Enum values removed: ${list(removed)}`);
    if (added.length) ctx.add(req ? 'info' : 'warning', where, `Enum values added: ${list(added)}${req ? '' : ' (clients may not handle them)'}`);
  } else if (!Array.isArray(o.enum) && Array.isArray(n.enum) && req) ctx.add('breaking', where, 'Now restricted to an enum');

  if (req) {
    for (const [k, tighter] of [['maxLength', (x, y) => y < x], ['maximum', (x, y) => y < x], ['maxItems', (x, y) => y < x], ['minLength', (x, y) => y > x], ['minimum', (x, y) => y > x], ['minItems', (x, y) => y > x]]) {
      if (n[k] !== undefined && (o[k] === undefined || tighter(o[k], n[k]))) ctx.add('breaking', where, `${k} tightened: ${o[k] ?? 'none'} → ${n[k]}`);
    }
  }

  if (o.items || n.items) diffSchema(o.items, n.items, dir, `${where}[]`, ctx, depth + 1, seen);

  const po = o.properties || {}, pn = n.properties || {};
  const ro = new Set(o.required || []), rn = new Set(n.required || []);
  for (const k of Object.keys(po)) {
    const path = `${where}.${k}`;
    if (!(k in pn)) {
      if (req) ctx.add(n.additionalProperties === false ? 'breaking' : 'warning', path, n.additionalProperties === false ? 'Field removed (and extra fields are rejected)' : 'Field removed');
      else ctx.add('breaking', path, 'Field removed from the response');
      continue;
    }
    if (req && !ro.has(k) && rn.has(k)) ctx.add('breaking', path, 'Field is now required');
    if (!req && ro.has(k) && !rn.has(k)) ctx.add('warning', path, 'Field is no longer always present');
    diffSchema(po[k], pn[k], dir, path, ctx, depth + 1, seen);
  }
  for (const k of Object.keys(pn)) {
    if (k in po) continue;
    const path = `${where}.${k}`;
    if (req && rn.has(k)) ctx.add('breaking', path, 'New required field');
    else ctx.add('info', path, req ? 'New optional field' : 'New field');
  }
}
