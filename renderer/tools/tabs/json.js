import { esc, copyText } from '../../shared/html.js';
import { prettyJson, isJson, highlightJson } from '../../shared/json.js';
import { sortedJson } from '../../shared/diff.js';
import { query } from '../../app/jsonpath.js';
import { PRE } from '../lib/ui.js';

// Where JSON text first goes wrong (JSON.parse no longer says): a small scanner over the grammar.
// → { at: index, expected: what would have been valid there }
function scanJson(s) {
  let i = 0;
  const fail = (expected) => { throw { at: i, expected }; };
  const ws = () => { while (/[ \t\n\r]/.test(s[i] || '')) i++; };
  const lit = (w) => { if (s.startsWith(w, i)) i += w.length; else fail('a value'); };
  const str = () => {
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\') { i++; if (s[i] === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) fail('4 hex digits after \\u'); i += 4; } else if (!'"\\/bfnrt'.includes(s[i] || 'x')) fail('a valid escape'); }
      else if (s.charCodeAt(i) < 32) fail('the closing quote (line breaks must be written \\n)');
      i++;
    }
    if (s[i] !== '"') fail('the closing quote'); i++;
  };
  const num = () => { const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i)); if (!m) fail('a number'); i += m[0].length; };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '{') {
      i++; ws(); if (s[i] === '}') { i++; return; }
      for (;;) { ws(); if (s[i] !== '"') fail('a "quoted" key'); str(); ws(); if (s[i] !== ':') fail('":"'); i++; value(); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === '}') { i++; return; } fail('"," or "}"'); }
    }
    if (c === '[') {
      i++; ws(); if (s[i] === ']') { i++; return; }
      for (;;) { value(); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === ']') { i++; return; } fail('"," or "]"'); }
    }
    if (c === '"') return str();
    if (c === 't') return lit('true'); if (c === 'f') return lit('false'); if (c === 'n') return lit('null');
    if (c === '-' || /\d/.test(c || '')) return num();
    fail(i >= s.length ? 'more input' : 'a value');
  };
  try { value(); ws(); if (i < s.length) fail('the end of the input'); return null; } catch (e) { if (e && 'at' in e) return e; throw e; }
}

// Why text isn't JSON, and where. → { message, line, col } | null
export function jsonError(text) {
  try { JSON.parse(text); return null; } catch (err) {
    const where = scanJson(text);
    if (!where) return { message: String(err.message || err), line: null, col: null };
    const before = text.slice(0, where.at).split('\n');
    const found = where.at >= text.length ? 'the end' : JSON.stringify(text[where.at]);
    return { message: `expected ${where.expected}, found ${found}`, line: before.length, col: before.at(-1).length + 1 };
  }
}

function queryHtml(S, value) {
  if (!S.jsonQuery.trim()) return '';
  let out;
  try { out = query(value, S.jsonQuery); } catch (err) { return `<p class="error-text">${esc(err.message)}</p>`; }
  return `<div class="hint mt-6">${out.length} match${out.length === 1 ? '' : 'es'}</div>
    <pre style="${PRE};max-height:240px">${highlightJson(JSON.stringify(out.length === 1 ? out[0] : out, null, 2))}</pre>`;
}

export default {
  id: 'json', label: 'JSON',
  state: { jsonInput: '', jsonQuery: '' },
  keys: ['jsonInput', 'jsonQuery'],
  primary: (S) => S.jsonInput,
  receive(S, value) { S.jsonInput = prettyJson(value); },
  render(S) {
    const filled = !!S.jsonInput.trim(), err = filled ? jsonError(S.jsonInput) : null, valid = filled && !err;
    const value = valid ? JSON.parse(S.jsonInput) : undefined;
    const size = new TextEncoder().encode(S.jsonInput).length;
    return `<div style="display:flex;gap:8px;align-items:flex-start">
      <div style="flex:1;display:flex;flex-direction:column;gap:4px;min-width:0"><label class="hint">Input${filled ? ` · ${size.toLocaleString()} bytes` : ''}</label>
        <textarea id="json-input" rows="18" placeholder='{"key":"value"}' spellcheck="false" style="font-family:monospace;font-size:12px">${esc(S.jsonInput)}</textarea>
        ${err ? `<p class="error-text" style="margin-top:4px">Invalid JSON${err.line ? ` at line ${err.line}, column ${err.col}` : ''}: ${esc(err.message)}</p>` : ''}</div>
      <div style="flex:1;display:flex;flex-direction:column;gap:4px;min-width:0"><label class="hint">Formatted</label>
        <pre style="${PRE};min-height:200px;max-height:50vh">${valid ? highlightJson(prettyJson(S.jsonInput)) : ''}</pre>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn-ghost small" id="json-format">Format</button><button class="btn-ghost small" id="json-minify">Minify</button>
          <button class="btn-ghost small" id="json-sort" title="Sort object keys at every level">Sort keys</button><button class="btn-ghost small" id="json-copy">Copy</button></div>
        <label class="hint mt-6" for="json-query">JSONPath query</label>
        <input id="json-query" type="text" placeholder="$.items[*].id · $..price · $.items[?(@.price < 10)]" value="${esc(S.jsonQuery)}" spellcheck="false" style="font-family:monospace"/>
        ${valid ? queryHtml(S, value) : ''}</div></div>`;
  },
  onInput(el, ctx) {
    if (el.id === 'json-input') { ctx.S.jsonInput = el.value; ctx.changed(el); }
    else if (el.id === 'json-query') { ctx.S.jsonQuery = el.value; ctx.changed(el); }
  },
  onClick(t, { S, rerender, recordSoon }) {
    if (t.id === 'json-format') { S.jsonInput = prettyJson(S.jsonInput); rerender(); }
    else if (t.id === 'json-minify') { try { S.jsonInput = JSON.stringify(JSON.parse(S.jsonInput)); } catch {} rerender(); }
    else if (t.id === 'json-sort') { if (isJson(S.jsonInput)) { S.jsonInput = sortedJson(S.jsonInput); recordSoon(); } rerender(); }
    else if (t.id === 'json-copy') copyText(prettyJson(S.jsonInput));
  },
};
