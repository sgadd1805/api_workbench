// Documentation helpers: flattening a schema into field rows, and short type labels.
import { deref } from './spec.js';

// Short type description: integer, string(date), Pet, array<string>, string {a, b, c}, …
export function typeLabel(schema, root, depth = 0) {
  if (!schema || depth > 3) return '';
  const ref = schema.$ref && schema.$ref.split('/').pop();
  const s = deref(root, schema);
  if (ref && (s?.type === 'object' || s?.properties || s?.allOf)) return ref;
  if (s?.oneOf || s?.anyOf) return (s.oneOf || s.anyOf).map((x) => typeLabel(x, root, depth + 1)).join(' | ');
  if (s?.allOf) return s.allOf.map((x) => typeLabel(x, root, depth + 1)).join(' & ');
  const t = [].concat(s?.type || []).filter((x) => x !== 'null').join(' | ') || (s?.properties ? 'object' : ref || 'any');
  const nullable = s?.nullable || [].concat(s?.type || []).includes('null') ? '?' : '';
  if (t === 'array') return `array<${typeLabel(s.items, root, depth + 1)}>${nullable}`;
  return (s?.format ? `${t}(${s.format})` : t) + nullable;
}

// Constraints worth showing next to a field: enum, format limits, default, example.
export function constraintsOf(s) {
  const out = [];
  if (s.enum) out.push(`one of: ${s.enum.slice(0, 8).map((e) => JSON.stringify(e)).join(', ')}${s.enum.length > 8 ? ', …' : ''}`);
  if (s.minLength !== undefined || s.maxLength !== undefined) out.push(`length ${s.minLength ?? 0}–${s.maxLength ?? '∞'}`);
  if (s.minimum !== undefined || s.maximum !== undefined) out.push(`range ${s.minimum ?? '−∞'}–${s.maximum ?? '∞'}`);
  if (s.minItems !== undefined || s.maxItems !== undefined) out.push(`items ${s.minItems ?? 0}–${s.maxItems ?? '∞'}`);
  if (s.pattern) out.push(`pattern ${s.pattern}`);
  if (s.default !== undefined) out.push(`default ${JSON.stringify(s.default)}`);
  if (s.example !== undefined && typeof s.example !== 'object') out.push(`e.g. ${JSON.stringify(s.example)}`);
  if (s.readOnly) out.push('read-only');
  if (s.writeOnly) out.push('write-only');
  if (s.deprecated) out.push('deprecated');
  return out;
}

// Schema → [{ path: 'owner.pets[].name', type, required, description, constraints }] for a docs table.
// Recursive schemas are cut off at the first repeat; very wide/deep schemas are capped.
export function fieldRows(schema, root, { maxRows = 300, maxDepth = 6 } = {}) {
  const rows = [];
  (function walk(raw, path, required, depth, seen) {
    if (rows.length >= maxRows || depth > maxDepth || !raw) return;
    const ref = raw.$ref;
    if (ref && seen.has(ref)) { rows.push({ path, type: ref.split('/').pop() + ' (recursive)', required, description: '', constraints: [] }); return; }
    const nextSeen = ref ? new Set(seen).add(ref) : seen;
    const s = deref(root, raw) || {};
    const merged = s.allOf ? s.allOf.map((x) => deref(root, x) || {}).reduce((a, b) => ({ ...a, ...b, properties: { ...a.properties, ...b.properties }, required: [...(a.required || []), ...(b.required || [])] }), { ...s, properties: { ...s.properties }, required: [...(s.required || [])] }) : s;
    if (path) rows.push({ path, type: typeLabel(raw, root), required, description: merged.description || s.description || '', constraints: constraintsOf(merged) });
    const type = [].concat(merged.type || []);
    if (merged.properties || type.includes('object')) {
      const req = new Set(merged.required || []);
      for (const [k, ps] of Object.entries(merged.properties || {})) walk(ps, path ? `${path}.${k}` : k, req.has(k), depth + 1, nextSeen);
    }
    if (type.includes('array') || merged.items) walk(merged.items, `${path || ''}[]`, false, depth + 1, nextSeen);
    for (const alt of merged.oneOf || merged.anyOf || []) walk(alt, path ? `${path} (${typeLabel(alt, root)})` : `(${typeLabel(alt, root)})`, false, depth + 1, nextSeen);
  })(schema, '', false, 0, new Set());
  return rows;
}
