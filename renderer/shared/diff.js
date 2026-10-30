import { esc } from './html.js';

// Text and JSON diffs for the Diff tool, Compare and a response's History tab.
//
// lineDiff(a, b, options) → rows [{ type: 'same' | 'add' | 'del', text, a: line number in A | null,
//   b: line number in B | null, words?: [{ text, changed }] (which parts of a changed line differ) }]
// Lines are matched with Myers' algorithm (shortest edit script). Only the differing middle is diffed,
// and if it needs more than maxEdits edits the middle is shown as all removed, then all added, so huge
// unrelated inputs can't freeze the window.

const MAX_EDITS = 3000;

// Myers' O((N+M)·D) diff of two arrays of comparable keys. → ops ['=' | '-' | '+'] or null if over maxD.
function myers(a, b, maxD) {
  const n = a.length, m = b.length, max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxD) return null;
    trace.push(v.slice(off - d, off + d + 1)); // v before this step, k = -d … d
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace, n, m) {
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vp = trace[d], at = (k) => vp[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push('='); x--; y--; }
    if (d > 0) { ops.push(x === prevX ? '+' : '-'); x = prevX; y = prevY; }
  }
  while (x > 0 && y > 0) { ops.push('='); x--; y--; }
  return ops.reverse();
}

const keyFor = ({ ignoreWhitespace, ignoreCase }) => (line) => {
  let s = line.replace(/\r$/, '');
  if (ignoreWhitespace) s = s.trim().replace(/\s+/g, ' ');
  return ignoreCase ? s.toLowerCase() : s;
};

// options: { ignoreWhitespace, ignoreCase, words = true (mark changed words), maxEdits }
export function lineDiff(aStr, bStr, { ignoreWhitespace = false, ignoreCase = false, words = true, maxEdits = MAX_EDITS } = {}) {
  const a = String(aStr ?? '').split('\n'), b = String(bStr ?? '').split('\n');
  const key = keyFor({ ignoreWhitespace, ignoreCase });
  const ka = a.map(key), kb = b.map(key);
  let pre = 0; while (pre < a.length && pre < b.length && ka[pre] === kb[pre]) pre++;
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && ka[a.length - 1 - suf] === kb[b.length - 1 - suf]) suf++;
  const am = ka.slice(pre, a.length - suf), bm = kb.slice(pre, b.length - suf);
  const ops = myers(am, bm, maxEdits) || [...am.map(() => '-'), ...bm.map(() => '+')];
  const rows = [];
  let i = 0, j = 0;
  const same = () => { rows.push({ type: 'same', text: b[j], a: i + 1, b: j + 1 }); i++; j++; };
  for (let s = 0; s < pre; s++) same();
  for (const op of ops) {
    if (op === '=') same();
    else if (op === '-') { rows.push({ type: 'del', text: a[i], a: i + 1, b: null }); i++; }
    else { rows.push({ type: 'add', text: b[j], a: null, b: j + 1 }); j++; }
  }
  for (let s = 0; s < suf; s++) same();
  if (words) markWords(rows);
  return rows;
}

// ---- word-level changes inside changed lines

const TOKEN = /\w+|\s+|[^\w\s]/g;
// Pairs each run of removed lines with the added lines after it (1st with 1st …) and marks the tokens
// that differ, when the two lines are similar enough for that to help.
function markWords(rows) {
  for (let s = 0; s < rows.length;) {
    if (rows[s].type !== 'del') { s++; continue; }
    let e = s; while (e < rows.length && rows[e].type === 'del') e++;
    let f = e; while (f < rows.length && rows[f].type === 'add') f++;
    for (let p = 0; p < Math.min(e - s, f - e); p++) {
      const del = rows[s + p], add = rows[e + p];
      const ta = del.text.match(TOKEN) || [], tb = add.text.match(TOKEN) || [];
      if (ta.length + tb.length > 600) continue;
      const ops = myers(ta, tb, 200); if (!ops) continue;
      const wa = [], wb = []; let x = 0, y = 0, kept = 0;
      for (const op of ops) {
        if (op === '=') { wa.push({ text: ta[x++], changed: false }); wb.push({ text: tb[y++], changed: false }); kept++; }
        else if (op === '-') wa.push({ text: ta[x++], changed: true });
        else wb.push({ text: tb[y++], changed: true });
      }
      if (kept / Math.max(ta.length, tb.length, 1) < 0.4) continue; // mostly different: highlight whole lines
      del.words = merge(wa); add.words = merge(wb);
    }
    s = f;
  }
}
const merge = (parts) => parts.reduce((out, p) => {
  const last = out[out.length - 1];
  if (last && last.changed === p.changed) last.text += p.text; else out.push({ ...p });
  return out;
}, []);

// ---- summaries and output

// → { added, removed, hunks, identical }
export function diffStats(rows) {
  let added = 0, removed = 0, hunks = 0, inHunk = false;
  for (const r of rows) {
    if (r.type === 'same') { inHunk = false; continue; }
    if (r.type === 'add') added++; else removed++;
    if (!inHunk) { hunks++; inHunk = true; }
  }
  return { added, removed, hunks, identical: !added && !removed };
}

// rows → [{ kind: 'rows', from, to } | { kind: 'gap', from, to, id }] keeping `context` unchanged lines
// around each change; longer unchanged runs become gaps (shown when their id is in `expanded`).
export function collapse(rows, context = 3, expanded = new Set()) {
  if (!Number.isFinite(context)) return [{ kind: 'rows', from: 0, to: rows.length }];
  const keep = new Uint8Array(rows.length);
  rows.forEach((r, i) => { if (r.type !== 'same') for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = 1; });
  const out = [];
  for (let i = 0; i < rows.length;) {
    let j = i; while (j < rows.length && keep[j] === keep[i]) j++;
    const id = `g${i}`;
    if (keep[i] || expanded.has(id) || j - i < 2) out.push({ kind: 'rows', from: i, to: j }); // a 1-line gap saves nothing
    else out.push({ kind: 'gap', from: i, to: j, id });
    i = j;
  }
  return out;
}

const PREFIX = { same: ' ', add: '+', del: '-' };
const CLS = { same: '', add: 'diff-add', del: 'diff-del' };
const lineText = (r) => (r.words ? r.words.map((w) => (w.changed ? `<span class="diff-word">${esc(w.text)}</span>` : esc(w.text))).join('') : esc(r.text));
const num = (n) => `<span class="diff-ln">${n ?? ''}</span>`;
// The index of each row's change block, so the Diff tool can jump between them.
function hunkIds(rows) {
  const ids = []; let h = -1, inHunk = false;
  for (const r of rows) { if (r.type === 'same') { inHunk = false; ids.push(null); } else { if (!inHunk) { h++; inHunk = true; } ids.push(h); } }
  return ids;
}
const gapHtml = (seg, span = '') => `<div class="diff-gap" data-gap="${seg.id}"${span}>⋯ ${seg.to - seg.from} unchanged line${seg.to - seg.from === 1 ? '' : 's'}</div>`;

// Unified view for a <pre>. options: { numbers: show line numbers, context: unchanged lines kept around
// changes (Infinity = all), expanded: Set of gap ids to show }
export function diffHtml(rows, { numbers = false, context = Infinity, expanded } = {}) {
  const hunk = hunkIds(rows);
  let lastHunk = null;
  return collapse(rows, context, expanded).map((seg) => (seg.kind === 'gap' ? gapHtml(seg) : rows.slice(seg.from, seg.to).map((r, k) => {
    const h = hunk[seg.from + k], first = h !== null && h !== lastHunk; lastHunk = h ?? lastHunk;
    return `<div class="diff-row ${CLS[r.type]}"${first ? ` data-hunk="${h}"` : ''}>${numbers ? num(r.a) + num(r.b) : ''}<span class="diff-sign">${PREFIX[r.type]}</span>${lineText(r)}</div>`;
  }).join(''))).join('');
}

// Side-by-side view: A on the left, B on the right; removed and added lines of a change share rows.
export function sideBySideHtml(rows, { context = Infinity, expanded } = {}) {
  const hunk = hunkIds(rows);
  const cell = (r, side) => (r ? `<td class="diff-ln">${r[side] ?? ''}</td><td class="diff-cell ${CLS[r.type]}">${lineText(r)}</td>` : '<td class="diff-ln"></td><td class="diff-cell diff-empty"></td>');
  const body = collapse(rows, context, expanded).map((seg) => {
    if (seg.kind === 'gap') return `<tr><td colspan="4">${gapHtml(seg)}</td></tr>`;
    const out = [];
    for (let i = seg.from; i < seg.to;) {
      const r = rows[i];
      if (r.type === 'same') { out.push(`<tr>${cell(r, 'a')}${cell(r, 'b')}</tr>`); i++; continue; }
      let e = i; while (e < seg.to && rows[e].type === 'del') e++;
      let f = e; while (f < seg.to && rows[f].type === 'add') f++;
      const dels = rows.slice(i, e), adds = rows.slice(e, f);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push(`<tr${k === 0 ? ` data-hunk="${hunk[i]}"` : ''}>${cell(dels[k], 'a')}${cell(adds[k], 'b')}</tr>`);
      i = Math.max(f, i + 1);
    }
    return out.join('');
  }).join('');
  return `<table class="diff-side"><colgroup><col class="diff-ln-col"/><col/><col class="diff-ln-col"/><col/></colgroup>${body}</table>`;
}

// A unified patch (as `diff -u` / git write it).
export function unifiedPatch(rows, { aName = 'A', bName = 'B', context = 3 } = {}) {
  const out = [`--- ${aName}`, `+++ ${bName}`];
  for (const seg of collapse(rows, context)) {
    if (seg.kind === 'gap' || !rows.slice(seg.from, seg.to).some((r) => r.type !== 'same')) continue;
    const part = rows.slice(seg.from, seg.to);
    const aStart = part.find((r) => r.a != null)?.a ?? (rows.slice(0, seg.from).reverse().find((r) => r.a != null)?.a ?? 0);
    const bStart = part.find((r) => r.b != null)?.b ?? (rows.slice(0, seg.from).reverse().find((r) => r.b != null)?.b ?? 0);
    const aLen = part.filter((r) => r.type !== 'add').length, bLen = part.filter((r) => r.type !== 'del').length;
    out.push(`@@ -${aStart}${aLen === 1 ? '' : ',' + aLen} +${bStart}${bLen === 1 ? '' : ',' + bLen} @@`);
    for (const r of part) out.push(PREFIX[r.type] + r.text);
  }
  return out.length > 2 ? out.join('\n') + '\n' : '';
}

// ---- JSON

// Pretty JSON with object keys sorted at every level (so key order doesn't show as a change).
export function sortedJson(text) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(JSON.parse(text)), null, 2);
}

const pathKey = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);
const show = (v) => (v === undefined ? '' : JSON.stringify(v));
// Field-by-field differences between two JSON values. → [{ path, kind: 'changed' | 'added' | 'removed' |
// 'type', a, b }] (a / b as JSON text), at most `limit`.
export function jsonChanges(a, b, { limit = 500 } = {}) {
  const out = [];
  const walk = (x, y, path) => {
    if (out.length >= limit) return;
    const tx = Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x, ty = Array.isArray(y) ? 'array' : y === null ? 'null' : typeof y;
    if (tx !== ty) { out.push({ path, kind: 'type', a: show(x), b: show(y) }); return; }
    if (tx === 'array') {
      for (let i = 0; i < Math.max(x.length, y.length) && out.length < limit; i++) {
        if (i >= y.length) out.push({ path: `${path}[${i}]`, kind: 'removed', a: show(x[i]), b: '' });
        else if (i >= x.length) out.push({ path: `${path}[${i}]`, kind: 'added', a: '', b: show(y[i]) });
        else walk(x[i], y[i], `${path}[${i}]`);
      }
    } else if (tx === 'object') {
      for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])]) {
        if (out.length >= limit) break;
        if (!(k in y)) out.push({ path: path + pathKey(k), kind: 'removed', a: show(x[k]), b: '' });
        else if (!(k in x)) out.push({ path: path + pathKey(k), kind: 'added', a: '', b: show(y[k]) });
        else walk(x[k], y[k], path + pathKey(k));
      }
    } else if (x !== y) out.push({ path, kind: 'changed', a: show(x), b: show(y) });
  };
  walk(a, b, '$');
  return out;
}
