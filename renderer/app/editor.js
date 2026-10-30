// The built-in code editor (request bodies, scripts) and the URL field's variable highlighting.
// A transparent <textarea> sits over a coloured <pre> of the same text, so editing, undo, selection
// and IME stay native. Adds line numbers, bracket matching, Tab / auto-indent, a wrap toggle, and
// {{variable}} autocomplete (also in the URL field). The textarea keeps its id, so events.js handles
// its edits like any other field.
import { lastChange } from './varlog.js';
import { esc } from '../shared/html.js';
import { highlight, matchBracket } from '../shared/highlight.js';
import { DB, S, saveDB, findReq } from './store.js';
import { DYNAMIC_VARS, VAR_SOURCE, parseDynamic } from '../shared/dynvars.js';

// Enabled variables of the open request's active environment: { name: { value, secret } }.
function envVars() {
  const p = S.req && findReq(S.req.id)?.p;
  const env = p?.envs?.find((e) => e.id === p.activeEnv);
  return Object.fromEntries((env?.vars || []).filter((v) => v.on && v.k).map((v) => [v.k, { value: v.v, secret: !!v.secret }]));
}
const activeEnvId = () => { const p = S.req && findReq(S.req.id)?.p; return p?.activeEnv ?? null; };
const varNames = () => Object.fromEntries(Object.keys(envVars()).map((k) => [k, true]));

const gutter = (text) => Array.from({ length: text.split('\n').length }, (_, i) => i + 1).join('\n');

// lang: 'json' | 'js' | 'xml' | 'text'
export function codeEditorHtml({ id, value = '', lang = 'text', rows = 8, placeholder = '' }) {
  const wrap = !!DB.settings.editorWrap;
  return `<div class="code-ed${wrap ? ' wrap' : ''}" style="--rows:${rows}">
    <div class="code-gutter" aria-hidden="true">${gutter(value)}</div>
    <div class="code-area"><pre class="code-hl" aria-hidden="true">${highlight(value, lang, { vars: varNames() })}\n</pre><textarea id="${esc(id)}" class="code-input" data-lang="${esc(lang)}" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="${esc(placeholder)}">${esc(value)}</textarea></div>
    <button class="btn-ghost small code-wrap-btn" data-action="editor-wrap" title="Wrap long lines (all editors)">${wrap ? 'No wrap' : 'Wrap'}</button></div>`;
}

export function urlFieldHtml(url) {
  return `<div class="url-field"><div class="url-hl" aria-hidden="true"><span>${highlight(url, 'text', { vars: varNames() })}</span></div><input class="url-input" id="url-input" type="text" spellcheck="false" value="${esc(url)}" placeholder="https://… or {{baseUrl}}/path"/></div>`;
}

// Re-colours an editor after its text, caret or scroll position changed.
export function refreshEditor(ta) {
  const ed = ta.closest('.code-ed'); if (!ed) return;
  const marks = document.activeElement === ta && ta.selectionStart === ta.selectionEnd ? matchBracket(ta.value, ta.selectionStart) : [];
  ed.querySelector('.code-hl').innerHTML = highlight(ta.value, ta.dataset.lang, { vars: varNames(), marks }) + '\n';
  const g = ed.querySelector('.code-gutter'), lines = ta.value.split('\n').length;
  if (g.dataset.lines !== String(lines)) { g.textContent = gutter(ta.value); g.dataset.lines = lines; }
  syncScroll(ta);
}

function syncScroll(ta) {
  const ed = ta.closest('.code-ed'); if (!ed) return;
  const hl = ed.querySelector('.code-hl');
  hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
  ed.querySelector('.code-gutter').scrollTop = ta.scrollTop;
}

export function refreshUrlField(input = document.getElementById('url-input')) {
  const hl = input?.parentElement?.querySelector('.url-hl'); if (!hl) return;
  hl.firstElementChild.innerHTML = highlight(input.value, 'text', { vars: varNames() });
  hl.scrollLeft = input.scrollLeft;
}

// Variables may change (env switch, extract rules, scripts): re-colour what's on screen.
export function refreshAllEditors() {
  for (const ta of document.querySelectorAll('.code-input')) refreshEditor(ta);
  refreshUrlField();
}

// ── {{variable}} autocomplete ─────────────────────────────────────────────────────────────────────
let ac = null; // { el, start, items, idx }

function acBox() {
  let box = document.getElementById('var-complete');
  if (!box) {
    box = document.createElement('div'); box.id = 'var-complete'; box.className = 'menu var-complete'; box.setAttribute('role', 'listbox');
    box.addEventListener('mousedown', (e) => { const it = e.target.closest('[data-idx]'); if (it) { e.preventDefault(); accept(+it.dataset.idx); } });
    document.body.append(box);
  }
  return box;
}

// Screen position just below the caret, via a mirror element styled like the field.
function caretXY(el) {
  const cs = getComputedStyle(el), m = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderTopWidth', 'boxSizing', 'tabSize', 'wordBreak']) m.style[p] = cs[p];
  Object.assign(m.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '0', width: el.clientWidth + 'px', whiteSpace: el.tagName === 'INPUT' ? 'pre' : cs.whiteSpace });
  m.textContent = el.value.slice(0, el.selectionStart);
  const mark = document.createElement('span'); mark.textContent = '​'; m.append(mark);
  document.body.append(m);
  const r = el.getBoundingClientRect();
  const xy = { x: r.left + mark.offsetLeft - el.scrollLeft, y: r.top + mark.offsetTop - el.scrollTop + mark.offsetHeight };
  m.remove();
  return xy;
}

function closeAc() { ac = null; const box = document.getElementById('var-complete'); if (box) box.style.display = 'none'; }

function updateAc(el) {
  const before = el.value.slice(0, el.selectionStart);
  const m = /\{\{\s*([\w.$-]*)$/.exec(before);
  if (!m || el.selectionStart !== el.selectionEnd) return closeAc();
  const vars = envVars(), q = m[1].toLowerCase();
  // Environment variables first; dynamic ones ({{$uuid}} …) when typing "$" (or nothing yet).
  const dyn = q === '' || q.startsWith('$') ? DYNAMIC_VARS.map((d) => [d.name, { value: d.description, dynamic: true }]) : [];
  const items = [...Object.entries(vars), ...dyn].filter(([k]) => k.toLowerCase().includes(q)).sort(([a, x], [b, y]) => (!!x.dynamic - !!y.dynamic) || (b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q)) || a.localeCompare(b)).slice(0, 40);
  if (!items.length) return closeAc();
  ac = { el, start: m.index, items, idx: 0 };
  renderAc();
}

function renderAc() {
  const box = acBox(), { x, y } = caretXY(ac.el);
  box.innerHTML = ac.items.map(([k, v], i) => `<div class="menu-item${i === ac.idx ? ' active' : ''}" role="option" data-idx="${i}" aria-selected="${i === ac.idx}">
    <span>{{${esc(k)}}}</span><span class="hint">${esc(v.secret ? '••••••' : String(v.value).slice(0, v.dynamic ? 60 : 40))}</span></div>`).join('');
  Object.assign(box.style, { display: 'block', left: Math.max(4, Math.min(x, innerWidth - 300)) + 'px', top: Math.min(y + 2, innerHeight - box.offsetHeight - 4) + 'px' });
  box.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function accept(i) {
  const { el, start, items } = ac, name = items[i][0];
  // Replace "{{partial" (and a "}}" already right after the caret) with the full {{name}}.
  const after = el.value.slice(el.selectionStart);
  const end = el.selectionStart + (/^[\w.$:+-]*\s*\}\}/.exec(after)?.[0].length || 0);
  el.focus(); el.setSelectionRange(start, end);
  document.execCommand('insertText', false, `{{${name}}}`);
  closeAc();
}

// ── key handling ──────────────────────────────────────────────────────────────────────────────────
function onKeydown(e) {
  const el = e.target;
  if (ac && el === ac.el) {
    const n = ac.items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { ac.idx = (ac.idx + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; renderAc(); }
    else if (e.key === 'Enter' || e.key === 'Tab') accept(ac.idx);
    else if (e.key === 'Escape') closeAc();
    else return;
    e.preventDefault(); e.stopPropagation(); return;
  }
  if (!el.classList?.contains('code-input') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    const { value, selectionStart: s, selectionEnd: t } = el;
    if (s === t && !e.shiftKey) return document.execCommand('insertText', false, '  ');
    // Indent / outdent the selected lines.
    const from = value.lastIndexOf('\n', s - 1) + 1, block = value.slice(from, t);
    const next = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
    el.setSelectionRange(from, t); document.execCommand('insertText', false, next);
    el.setSelectionRange(from, from + next.length);
  } else if (e.key === 'Enter' && !e.shiftKey) {
    // Keep the indentation; one level deeper after an opening bracket.
    const { value, selectionStart: s } = el;
    const line = value.slice(value.lastIndexOf('\n', s - 1) + 1, s);
    const base = /^[ \t]*/.exec(line)[0], opens = /[[{(]\s*$/.test(line);
    const indent = base + (opens ? '  ' : '');
    // Between a pair, as in "{|}": put the closer on its own line below.
    const between = opens && /^[ \t]*[\]})]/.test(value.slice(s));
    e.preventDefault();
    document.execCommand('insertText', false, '\n' + indent + (between ? '\n' + base : ''));
    if (between) { const at = el.selectionStart - base.length - 1; el.setSelectionRange(at, at); }
  }
}

// Shows the value of the {{variable}} under the mouse in the URL field's tooltip.
let measureCtx = null;
function onUrlHover(e) {
  const el = e.target;
  const cs = getComputedStyle(el);
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const x = e.clientX - el.getBoundingClientRect().left - parseFloat(cs.paddingLeft) - parseFloat(cs.borderLeftWidth) + el.scrollLeft;
  let lo = 0, hi = el.value.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (measureCtx.measureText(el.value.slice(0, mid + 1)).width < x) lo = mid + 1; else hi = mid; }
  const hit = [...el.value.matchAll(new RegExp(VAR_SOURCE, 'g'))].find((m) => lo >= m.index && lo < m.index + m[0].length);
  const vars = envVars();
  const dyn = hit && parseDynamic(hit[1]);
  const set = hit && !dyn && vars[hit[1]] && lastChange(activeEnvId(), hit[1]);
  const title = !hit ? '' : dyn ? `{{${hit[1]}}}: ${DYNAMIC_VARS.find((d) => d.name === '$' + dyn.name)?.description}, made when sending${dyn.offsetMs ? ' (offset applied)' : ''}` : !vars[hit[1]] ? `{{${hit[1]}}} isn't defined in the active environment` : `{{${hit[1]}}} = ${vars[hit[1]].secret ? '•••••• (secret)' : vars[hit[1]].value}${set ? `\nSet ${new Date(set.at).toLocaleTimeString()} by ${set.source}` : ''}`;
  if (el.title !== title) el.title = title;
}

let selTimer = 0;
export function wireEditors() {
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.classList?.contains('code-input')) refreshEditor(el);
    else if (el.id === 'url-input') refreshUrlField(el);
    else return;
    updateAc(el);
  });
  document.addEventListener('scroll', (e) => {
    if (e.target.classList?.contains('code-input')) syncScroll(e.target);
    else if (e.target.id === 'url-input') refreshUrlField(e.target);
  }, true);
  // Bracket matching follows the caret.
  document.addEventListener('selectionchange', () => {
    const el = document.activeElement;
    if (el?.classList.contains('code-input')) { cancelAnimationFrame(selTimer); selTimer = requestAnimationFrame(() => refreshEditor(el)); }
    else if (el?.id === 'url-input') requestAnimationFrame(() => refreshUrlField(el));
  });
  document.addEventListener('focusout', (e) => {
    if (ac && e.target === ac.el) closeAc();
    if (e.target.classList?.contains('code-input')) refreshEditor(e.target); // drop the bracket marks
  });
  document.addEventListener('mousemove', (e) => { if (e.target.id === 'url-input') onUrlHover(e); });
}

export const editorActions = {
  'editor-wrap'() {
    DB.settings.editorWrap = !DB.settings.editorWrap; saveDB();
    for (const ed of document.querySelectorAll('.code-ed')) {
      ed.classList.toggle('wrap', DB.settings.editorWrap);
      ed.querySelector('.code-wrap-btn').textContent = DB.settings.editorWrap ? 'No wrap' : 'Wrap';
      refreshEditor(ed.querySelector('.code-input'));
    }
  },
};
