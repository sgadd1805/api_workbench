// Syntax colouring for the code editor and response viewer: JSON, JavaScript, XML/HTML, or plain
// text, plus {{variables}} in any of them (var-ok when defined, var-missing when not).
// highlight(text, lang, { vars, marks }) → HTML. marks: character offsets to wrap in
// <span class="bracket-match"> (the bracket pair at the caret).
import { esc } from './html.js';
import { VAR_SOURCE, isDynamic } from './dynvars.js';

const VAR_TOKEN = new RegExp(VAR_SOURCE, 'y');

const JS_KEYWORDS = new Set('await async break case catch class const continue default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while yield'.split(' '));
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

// Token rules per language, tried in order at each position (sticky regexes).
const RULES = {
  json: [
    ['var', VAR_TOKEN],
    ['str', /"(?:\\.|[^"\\\n])*"?/y],
    ['num', /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
    ['word', /[A-Za-z_$][\w$]*/y],
  ],
  js: [
    ['var', VAR_TOKEN],
    ['comment', /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
    ['str', /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?/y],
    ['num', /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
    ['word', /[A-Za-z_$][\w$]*/y],
  ],
  xml: [
    ['var', VAR_TOKEN],
    ['comment', /<!--[\s\S]*?(?:-->|$)/y],
    ['tag', /<\/?[\w:.-]+|\/?>/y],
    ['attr', /[\w:.-]+(?==)/y],
    ['str', /"[^"]*"?|'[^']*'?/y],
  ],
  graphql: [
    ['var', VAR_TOKEN],
    ['comment', /#[^\n]*/y],
    ['str', /"""[\s\S]*?(?:"""|$)|"(?:\\.|[^"\\\n])*"?/y],
    ['gqlvar', /\$[A-Za-z_]\w*/y],
    ['num', /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
    ['word', /[A-Za-z_][\w]*/y],
  ],
  text: [['var', VAR_TOKEN]],
};
const GQL_KEYWORDS = new Set(['query', 'mutation', 'subscription', 'fragment', 'on', 'type', 'input', 'enum', 'interface', 'union', 'scalar', 'schema', 'extend', 'directive', 'implements']);

export const MAX_HIGHLIGHT = 300_000; // longer text is shown uncoloured

export function langFor(contentTypeOrBody = '') {
  const s = String(contentTypeOrBody);
  if (/json/i.test(s)) return 'json';
  if (/xml|html/i.test(s)) return 'xml';
  if (/javascript/i.test(s)) return 'js';
  return 'text';
}

export function highlight(text, lang = 'text', { vars = null, marks = [] } = {}) {
  text = String(text ?? '');
  if (text.length > MAX_HIGHLIGHT) return esc(text);
  const rules = RULES[lang] || RULES.text;
  const markSet = new Set(marks);
  let out = '', plain = '', i = 0;
  // Plain characters are buffered so marks can be applied to single characters within them.
  const flushPlain = () => {
    if (!plain) return;
    const start = i - plain.length;
    if (!markSet.size) out += esc(plain);
    else for (let k = 0; k < plain.length; k++) out += markSet.has(start + k) ? `<span class="bracket-match">${esc(plain[k])}</span>` : esc(plain[k]);
    plain = '';
  };
  outer: while (i < text.length) {
    for (const [type, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (!m || !m[0]) continue;
      flushPlain();
      const tok = m[0];
      out += span(type, tok, text, i + tok.length, lang, vars);
      i += tok.length;
      continue outer;
    }
    plain += text[i]; i++;
    // keep `i` pointing past the buffered chars so flushPlain can compute offsets
  }
  flushPlain();
  return out;
}

function span(type, tok, text, end, lang, vars) {
  if (type === 'var') {
    const name = tok.slice(2, -2).trim();
    const cls = isDynamic(name) ? 'var var-dyn' : !vars ? 'var' : Object.hasOwn(vars, name) ? 'var var-ok' : 'var var-missing';
    return `<span class="${cls}">${esc(tok)}</span>`;
  }
  if (type === 'str') {
    // A JSON string followed by a colon is a key.
    if (lang === 'json' && /^\s*:/.test(text.slice(end, end + 20))) return `<span class="json-key">${withVars(tok, vars)}</span>`;
    return `<span class="${lang === 'xml' ? 'xml-str' : 'json-str'}">${withVars(tok, vars)}</span>`;
  }
  if (type === 'num') return `<span class="json-num">${esc(tok)}</span>`;
  if (type === 'gqlvar') return `<span class="json-key">${esc(tok)}</span>`;
  if (type === 'comment') return `<span class="code-comment">${esc(tok)}</span>`;
  if (type === 'tag') return `<span class="xml-tag">${esc(tok)}</span>`;
  if (type === 'attr') return `<span class="xml-attr">${esc(tok)}</span>`;
  if (type === 'word') {
    if (tok === 'null' || tok === 'undefined') return `<span class="json-null">${tok}</span>`;
    if (LITERALS.has(tok)) return `<span class="json-bool">${tok}</span>`;
    if (lang === 'js' && JS_KEYWORDS.has(tok)) return `<span class="code-kw">${tok}</span>`;
    if (lang === 'graphql' && GQL_KEYWORDS.has(tok)) return `<span class="code-kw">${tok}</span>`;
  }
  return esc(tok);
}

// {{variables}} inside strings are still marked.
const withVars = (tok, vars) => esc(tok).replace(new RegExp(VAR_SOURCE, 'g'), (m, name) =>
  `<span class="${isDynamic(name) ? 'var var-dyn' : !vars ? 'var' : Object.hasOwn(vars, name) ? 'var var-ok' : 'var var-missing'}">${m}</span>`);

const PAIRS = { '(': ')', '[': ']', '{': '}' };
const OPEN = { ')': '(', ']': '[', '}': '{' };

// Offsets of the bracket next to the caret and its partner, or [] (ignores brackets in strings
// only roughly: good enough for bodies and scripts).
export function matchBracket(text, caret) {
  for (const at of [caret - 1, caret]) {
    const c = text[at];
    if (PAIRS[c]) { const j = scan(text, at, 1, c, PAIRS[c]); return j < 0 ? [] : [at, j]; }
    if (OPEN[c]) { const j = scan(text, at, -1, c, OPEN[c]); return j < 0 ? [] : [j, at]; }
  }
  return [];
}

function scan(text, from, dir, self, other) {
  let depth = 0;
  const limit = Math.min(text.length, 200_000);
  for (let i = from; i >= 0 && i < limit; i += dir) {
    if (text[i] === self) depth++;
    else if (text[i] === other && --depth === 0) return i;
  }
  return -1;
}
