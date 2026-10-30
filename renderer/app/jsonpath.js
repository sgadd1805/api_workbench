// A JSONPath subset for the response filter: $, .key, ['key'], [0], [-1], [*], .*, ..key (recursive),
// [a,b], [start:end], and filters [?(@.price < 10)], [?(@.tag == 'x')], [?(@.id)].
// Also accepts a bare path without the leading $ ("data.items[0]").
// query(value, path) → array of matches; throws on a malformed path.

function tokenize(path) {
  let s = path.trim();
  if (!s.startsWith('$')) s = '$' + (s.startsWith('[') || s.startsWith('.') ? '' : '.') + s;
  const steps = [];
  let i = 1;
  const fail = (msg) => { throw new Error(`${msg} at ${i} in ${path}`); };
  while (i < s.length) {
    if (s.startsWith('..', i)) {
      i += 2;
      if (s[i] === '[') { steps.push({ type: 'descend' }); continue; }
      const m = /^(\*|[\w$-]+)/.exec(s.slice(i)); if (!m) fail('Expected a name after ..');
      steps.push({ type: 'descend' }, m[1] === '*' ? { type: 'wild' } : { type: 'key', keys: [m[1]] }); i += m[1].length;
    } else if (s[i] === '.') {
      i++;
      const m = /^(\*|[\w$-]+)/.exec(s.slice(i)); if (!m) fail('Expected a name after .');
      steps.push(m[1] === '*' ? { type: 'wild' } : { type: 'key', keys: [m[1]] }); i += m[1].length;
    } else if (s[i] === '[') {
      const end = closing(s, i); if (end < 0) fail('Unclosed [');
      steps.push(bracket(s.slice(i + 1, end).trim(), fail)); i = end + 1;
    } else fail(`Unexpected "${s[i]}"`);
  }
  return steps;
}

// Index of the ] matching the [ at i, skipping quoted strings and nested brackets.
function closing(s, i) {
  let depth = 0, quote = null;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (quote) { if (c === '\\') j++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return j;
  }
  return -1;
}

function bracket(inner, fail) {
  if (inner === '*') return { type: 'wild' };
  if (inner.startsWith('?')) return { type: 'filter', test: compileFilter(inner.slice(1).trim().replace(/^\((.*)\)$/s, '$1'), fail) };
  const slice = /^(-?\d*)\s*:\s*(-?\d*)$/.exec(inner);
  if (slice) return { type: 'slice', start: slice[1] === '' ? null : +slice[1], end: slice[2] === '' ? null : +slice[2] };
  const parts = inner.split(/\s*,\s*/).map((p) => {
    if (/^-?\d+$/.test(p)) return +p;
    const q = /^(['"])(.*)\1$/s.exec(p); if (q) return q[2].replace(/\\(.)/g, '$1');
    return fail(`Bad selector [${inner}]`);
  });
  return { type: 'key', keys: parts };
}

// "@.a.b op literal" or "@.a" (exists / truthy). Literals: numbers, 'strings', "strings", true, false, null.
function compileFilter(expr, fail) {
  const m = /^@((?:\.[\w$-]+|\[\d+\]|\[(['"]).*?\2\])*)\s*(?:(==|!=|<=|>=|<|>|=~)\s*(.+))?$/s.exec(expr);
  if (!m) fail(`Unsupported filter ${expr}`);
  const path = [...m[1].matchAll(/\.([\w$-]+)|\[(\d+)\]|\[(['"])(.*?)\3\]/g)].map((x) => x[1] ?? (x[2] != null ? +x[2] : x[4]));
  const get = (v) => path.reduce((o, k) => (o == null ? undefined : o[k]), v);
  if (!m[3]) return (v) => { const x = get(v); return x !== undefined && x !== null && x !== false; };
  const raw = m[4].trim();
  let lit;
  if (m[3] === '=~') { const r = /^\/(.*)\/([a-z]*)$/s.exec(raw); if (!r) fail('=~ needs /regex/'); lit = new RegExp(r[1], r[2]); }
  else if (/^(['"]).*\1$/s.test(raw)) lit = raw.slice(1, -1);
  else if (raw === 'true' || raw === 'false') lit = raw === 'true';
  else if (raw === 'null') lit = null;
  else if (!Number.isNaN(Number(raw))) lit = Number(raw);
  else fail(`Bad value ${raw}`);
  const op = { '==': (a, b) => a === b, '!=': (a, b) => a !== b, '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b, '=~': (a, b) => typeof a === 'string' && b.test(a) }[m[3]];
  return (v) => op(get(v), lit);
}

const children = (v) => (v && typeof v === 'object' ? Object.values(v) : []);
function descendants(v, out = []) { out.push(v); for (const c of children(v)) descendants(c, out); return out; }

function apply(step, nodes) {
  const out = [];
  for (const v of nodes) {
    if (step.type === 'descend') out.push(...descendants(v));
    else if (step.type === 'wild') out.push(...children(v));
    else if (step.type === 'filter') out.push(...children(v).filter((c) => { try { return step.test(c); } catch { return false; } }));
    else if (step.type === 'slice') {
      if (!Array.isArray(v)) continue;
      const n = v.length, norm = (x, d) => (x == null ? d : x < 0 ? Math.max(0, n + x) : Math.min(n, x));
      out.push(...v.slice(norm(step.start, 0), norm(step.end, n)));
    } else for (const k of step.keys) {
      if (v == null || typeof v !== 'object') continue;
      const key = typeof k === 'number' && Array.isArray(v) && k < 0 ? v.length + k : k;
      if (Object.hasOwn(v, key)) out.push(v[key]);
    }
  }
  return out;
}

export function query(value, path) {
  // "..key" after a descend step means: that key on the node or any descendant.
  return tokenize(path).reduce((nodes, step) => apply(step, nodes), [value]);
}
