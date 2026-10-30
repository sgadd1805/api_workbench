// Diff tab: text mode (A and B pasted, loaded from files, or sent from responses) and folder mode
// (compare-folders in main/folders.js). Both use shared/diff.js: side-by-side or unified view, changed
// words marked, unchanged stretches folded, jump between changes, ignore whitespace / case, JSON
// pretty-printed (keys sorted) with a field-by-field list of changes, and a patch to copy.
import { esc, copyText } from '../../shared/html.js';
import { prettyJson, isJson } from '../../shared/json.js';
import { lineDiff, diffHtml, sideBySideHtml, diffStats, unifiedPatch, sortedJson, jsonChanges } from '../../shared/diff.js';
import { formatXml } from '../lib/xml.js';
import { PRE } from '../lib/ui.js';
import { api, embedded } from '../api.js';

const SECTIONS = [['modified', 'Modified', ''], ['onlyA', 'Only in A', 'diff-del'], ['onlyB', 'Only in B', 'diff-add'], ['unchanged', 'Unchanged', '']];
const CONTEXT = 3;
const lines = (s) => (s ? s.split('\n').length : 0);
const baseName = (p) => String(p || '').split(/[\\/]/).pop();

// How A and B are compared: 'json' when both parse (or chosen), 'xml' when both format as XML, else text.
function prepare(S, a, b) {
  const fmt = S.diffFormat === 'auto' ? (a.trim() && b.trim() && isJson(a) && isJson(b) ? 'json' : /^\s*</.test(a) && /^\s*</.test(b) && formatXml(a) && formatXml(b) ? 'xml' : 'text') : S.diffFormat;
  if (fmt === 'json' && isJson(a || 'null') && isJson(b || 'null')) {
    const pretty = (s) => (!s.trim() ? '' : S.diffSortKeys ? sortedJson(s) : prettyJson(s));
    return { fmt, a: pretty(a), b: pretty(b), fields: a.trim() && b.trim() ? jsonChanges(JSON.parse(a), JSON.parse(b)) : null };
  }
  if (fmt === 'xml') return { fmt, a: formatXml(a) ?? a, b: formatXml(b) ?? b, fields: null };
  return { fmt: fmt === 'json' ? 'text' : fmt, a, b, fields: null };
}

const check = (id, label, on, title = '') => `<label class="hint diff-opt" title="${esc(title)}"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}/> ${label}</label>`;
const btn = (id, label, title = '', extra = '') => `<button class="btn-ghost small" id="${id}" title="${esc(title)}"${extra}>${label}</button>`;

function optionsBar(S, fmt) {
  const view = (v, label) => `<button class="btn-ghost small${S.diffView === v ? ' compare-active' : ''}" id="diff-view-${v}" aria-pressed="${S.diffView === v}">${label}</button>`;
  return `<div class="diff-bar">${view('split', 'Side by side')}${view('unified', 'Unified')}
    <select id="diff-format" title="How A and B are compared">${[['auto', `Auto${S.diffFormat === 'auto' ? ` (${fmt})` : ''}`], ['json', 'JSON'], ['xml', 'XML'], ['text', 'Text']].map(([v, l]) => `<option value="${v}" ${S.diffFormat === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    ${check('diff-ignore-ws', 'Ignore whitespace', S.diffIgnoreWs, 'Indentation, trailing spaces and runs of spaces don\'t count')}
    ${check('diff-ignore-case', 'Ignore case', S.diffIgnoreCase)}
    ${fmt === 'json' ? check('diff-sort-keys', 'Ignore key order', S.diffSortKeys, 'Sort object keys before comparing') : ''}
    ${check('diff-only-changes', 'Only changes', S.diffOnlyChanges, `Fold unchanged lines, keeping ${CONTEXT} around each change`)}</div>`;
}

// The comparison of two texts: summary with change navigation, JSON field changes, and the diff itself.
function result(S, a, b, names) {
  const p = prepare(S, a, b);
  const rows = lineDiff(p.a, p.b, { ignoreWhitespace: S.diffIgnoreWs, ignoreCase: S.diffIgnoreCase });
  const st = diffStats(rows);
  S._rows = rows; S._names = names; S._hunks = st.hunks; // for navigation and Copy patch
  const opts = { context: S.diffOnlyChanges ? CONTEXT : Infinity, expanded: new Set(S.diffExpanded) };
  const ignoring = [S.diffIgnoreWs && 'whitespace', S.diffIgnoreCase && 'case', p.fmt === 'json' && S.diffSortKeys && 'key order'].filter(Boolean);
  const summary = st.identical
    ? `<span class="diff-same-badge">Identical${ignoring.length ? ` (ignoring ${ignoring.join(', ')})` : ''}</span>`
    : `<span class="diff-count-add">+${st.added}</span> <span class="diff-count-del">−${st.removed}</span> <span class="hint">in ${st.hunks} change${st.hunks === 1 ? '' : 's'}</span>
      ${btn('diff-prev', '↑', 'Previous change (Alt+↑)')}${btn('diff-next', '↓', 'Next change (Alt+↓)')}<span class="hint" id="diff-pos">${S.diffHunk >= 0 ? `Change ${S.diffHunk + 1} of ${st.hunks}` : ''}</span>`;
  const fields = p.fields?.length ? `<details class="diff-fields-box"${p.fields.length <= 30 ? ' open' : ''}><summary class="hint">${p.fields.length}${p.fields.length >= 500 ? '+' : ''} field change${p.fields.length === 1 ? '' : 's'}</summary>
      <table class="diff-fields">${p.fields.map((f) => `<tr><td><code>${esc(f.path)}</code></td><td class="hint">${f.kind}</td><td class="diff-del">${esc(f.a)}</td><td class="diff-add">${esc(f.b)}</td></tr>`).join('')}</table></details>` : '';
  const body = st.identical && !a && !b ? '' : S.diffView === 'split'
    ? `<div class="diff-out" style="${PRE}">${sideBySideHtml(rows, opts)}</div>`
    : `<pre class="diff-out" style="${PRE}">${diffHtml(rows, { ...opts, numbers: true })}</pre>`;
  return `<div class="diff-summary">${summary}<span class="grow"></span>${st.identical ? '' : btn('diff-copy-patch', 'Copy patch', 'Copy as a unified diff (diff -u / git format)')}</div>${fields}${body}`;
}

function renderText(S) {
  const p = S.diffA || S.diffB ? prepare(S, S.diffA, S.diffB) : { fmt: 'text' };
  const pane = (side, value, name) => `<div class="grow min0"><div class="diff-pane-head"><span class="hint">${side.toUpperCase()}${name ? ` · ${esc(name)}` : ''} · ${lines(value)} line${lines(value) === 1 ? '' : 's'}</span>
      <span class="grow"></span>${btn(`diff-load-${side}`, 'Open…', `Load ${side.toUpperCase()} from a file`)}${btn(`diff-paste-${side}`, 'Paste', 'Paste from the clipboard')}</div>
    <textarea id="diff-${side}" rows="${S.diffA || S.diffB ? 6 : 12}" placeholder="${side === 'a' ? 'Original' : 'Changed'} text, JSON or XML" spellcheck="false" class="mono">${esc(value)}</textarea></div>`;
  return `${optionsBar(S, p.fmt)}
    <div class="diff-inputs">${pane('a', S.diffA, S.diffNameA)}
      <div class="diff-mid">${btn('diff-swap', '⇄', 'Swap A and B')}${btn('diff-clear', '✕', 'Clear both')}</div>
      ${pane('b', S.diffB, S.diffNameB)}</div>
    ${S.diffA || S.diffB ? result(S, S.diffA, S.diffB, [S.diffNameA || 'A', S.diffNameB || 'B']) : '<p class="hint">Paste or open two texts, or use “Send to Diff” on two responses.</p>'}`;
}

function renderFolder(S) {
  const pathRow = (side, value) => `<div class="path-row"><label class="hint" style="width:28px;flex-shrink:0">${side.toUpperCase()}</label>
      <input id="folder-path-${side}" type="text" placeholder="${/^Win/.test(navigator.platform) ? 'C:\\path\\to\\' : '/path/to/'}folder-${side}" value="${esc(value)}" spellcheck="false"/>
      <button class="btn-ghost small" id="browse-${side}">Browse</button></div>`;
  const inputs = `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
    ${pathRow('a', S.folderPathA)}${pathRow('b', S.folderPathB)}
    <div class="row gap-6 items-center"><button class="btn-primary small" id="folder-compare" ${S.folderComparing ? 'disabled' : ''}>${S.folderComparing ? 'Comparing…' : 'Compare'}</button>
      ${btn('folder-swap', '⇄ Swap', 'Swap A and B')}</div></div>`;
  if (S.folderError) return inputs + `<p class="error-text">${esc(S.folderError)}</p>`;
  const r = S.folderResult; if (!r) return inputs;
  const f = S.folderFilter.trim().toLowerCase();
  const match = (it) => !f || (typeof it === 'string' ? it : it.path).toLowerCase().includes(f);
  const section = ([key, label, cls]) => {
    const items = r[key].filter(match);
    return `<div style="margin-bottom:8px"><div class="hint" style="cursor:pointer" data-fold="${key}">${S.folderExpanded[key] ? '▼' : '▶'} ${label} (${items.length}${f ? ` of ${r[key].length}` : ''})</div>
      ${S.folderExpanded[key] ? `<div class="row-list">${items.map((it) => { const p = typeof it === 'string' ? it : it.path; return `<div class="${cls}${p === S.folderSelectedFile ? ' active' : ''}" data-file="${esc(p)}">${esc(p)}</div>`; }).join('')}</div>` : ''}</div>`;
  };
  const sel = r.modified.find((m) => m.path === S.folderSelectedFile);
  const detail = !sel ? '' : `<h4 class="section-title mt-10">${esc(sel.path)}</h4>` + (sel.tooLarge ? '<p class="hint">File too large to diff.</p>' : sel.binary ? '<p class="hint">Binary files differ.</p>'
    : result(S, sel.a, sel.b, [`a/${sel.path}`, `b/${sel.path}`]));
  const summary = `<p class="hint mb-8">${r.modified.length} modified · ${r.onlyA.length} only in A · ${r.onlyB.length} only in B · ${r.unchanged.length} unchanged</p>`;
  return inputs + optionsBar(S, sel ? prepare(S, sel.a || '', sel.b || '').fmt : 'text') + summary
    + `<input type="text" id="folder-filter" class="mb-8 w-full" placeholder="Filter files…" value="${esc(S.folderFilter)}" spellcheck="false"/>`
    + SECTIONS.map(section).join('') + detail;
}

async function runFolderCompare({ S, rerender, record, renderHistory }) {
  Object.assign(S, { folderComparing: true, folderError: '', folderResult: null, folderSelectedFile: null });
  rerender();
  const res = await api.compareFolders(S.folderPathA, S.folderPathB);
  S.folderComparing = false;
  if (!res.ok) S.folderError = res.error; else { S.folderResult = res; record(); if (res.modified[0]) S.folderSelectedFile = res.modified[0].path; }
  rerender();
  renderHistory();
}

// Scrolls change h (0-based) into view and marks it.
function goTo(S, h) {
  if (!S._hunks) return;
  S.diffHunk = ((h % S._hunks) + S._hunks) % S._hunks;
  document.querySelectorAll('.diff-current').forEach((el) => el.classList.remove('diff-current'));
  const el = document.querySelector(`[data-hunk="${S.diffHunk}"]`);
  if (el) { el.classList.add('diff-current'); el.scrollIntoView({ block: 'center' }); }
  const pos = document.getElementById('diff-pos'); if (pos) pos.textContent = `Change ${S.diffHunk + 1} of ${S._hunks}`;
}

// Alt+↑ / Alt+↓ move between changes wherever focus is (while a diff is on screen).
let shown = null; // the state last rendered
document.addEventListener('keydown', (e) => {
  if (!e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || !shown || !document.querySelector('.diff-out')) return;
  e.preventDefault();
  goTo(shown, shown.diffHunk + (e.key === 'ArrowDown' ? 1 : -1));
});

export default {
  id: 'diff', label: 'Diff',
  state: {
    diffMode: 'text', diffA: '', diffB: '', diffNameA: '', diffNameB: '',
    diffView: embedded ? 'unified' : 'split', diffFormat: 'auto', diffIgnoreWs: false, diffIgnoreCase: false, diffSortKeys: true, diffOnlyChanges: true,
    diffExpanded: [], diffHunk: -1,
    folderPathA: '', folderPathB: '', folderResult: null, folderError: '', folderComparing: false, folderSelectedFile: null, folderFilter: '',
    folderExpanded: { onlyA: true, onlyB: true, modified: true, unchanged: false },
  },
  keys: ['diffA', 'diffB', 'diffNameA', 'diffNameB', 'diffMode', 'diffView', 'diffFormat', 'diffIgnoreWs', 'diffIgnoreCase', 'diffSortKeys', 'diffOnlyChanges', 'folderPathA', 'folderPathB'],
  // First value goes to A, the next to B, so two responses can be sent in turn.
  receive(S, value) {
    S.diffMode = 'text'; S.diffExpanded = []; S.diffHunk = -1;
    if (!S.diffA || S.diffB) { S.diffA = value; S.diffB = ''; S.diffNameA = 'sent'; S.diffNameB = ''; } else { S.diffB = value; S.diffNameB = 'sent'; }
  },
  primary: (S) => (S.diffMode === 'folder' ? (S.folderResult ? S.folderPathA + ' ↔ ' + S.folderPathB : '') : S.diffA && S.diffB ? `${S.diffA.slice(0, 40)} ↔ ${S.diffB.slice(0, 40)}` : ''),
  render(S) {
    shown = S;
    const modeBtn = (mode, label) => `<button class="btn-ghost small${S.diffMode === mode ? ' compare-active' : ''}" id="diff-mode-${mode}">${label}</button>`;
    return `<div class="row gap-6 items-center mb-10">${modeBtn('text', 'Text')}${modeBtn('folder', 'Folders')}</div>`
      + (S.diffMode === 'folder' ? renderFolder(S) : renderText(S));
  },
  onRestore({ S }) {
    // Folder results aren't stored in history; the user re-runs the compare.
    if (S.diffMode === 'folder') { S.folderResult = null; S.folderSelectedFile = null; }
    S.diffExpanded = []; S.diffHunk = -1;
  },
  onInput(el, ctx) {
    const { S } = ctx;
    switch (el.id) {
      case 'diff-a': S.diffA = el.value; S.diffHunk = -1; return ctx.changed(el);
      case 'diff-b': S.diffB = el.value; S.diffHunk = -1; return ctx.changed(el);
      case 'folder-filter': S.folderFilter = el.value; return ctx.keepFocus(el.id);
      // No re-render for the path inputs, so typing keeps focus.
      case 'folder-path-a': S.folderPathA = el.value; return;
      case 'folder-path-b': S.folderPathB = el.value; return;
    }
  },
  async onClick(t, ctx) {
    const { S, rerender, recordSoon } = ctx;
    const fold = t.closest('[data-fold]'); if (fold) { S.folderExpanded[fold.dataset.fold] = !S.folderExpanded[fold.dataset.fold]; return rerender(); }
    const file = t.closest('[data-file]'); if (file) { S.folderSelectedFile = file.dataset.file; S.diffExpanded = []; S.diffHunk = -1; return rerender(); }
    const gap = t.closest('[data-gap]'); if (gap) { S.diffExpanded = [...S.diffExpanded, gap.dataset.gap]; return rerender(); }
    const id = t.closest('button')?.id || t.id;
    switch (id) {
      case 'diff-mode-folder': S.diffMode = 'folder'; return rerender();
      case 'diff-mode-text': S.diffMode = 'text'; return rerender();
      case 'diff-view-split': S.diffView = 'split'; return rerender();
      case 'diff-view-unified': S.diffView = 'unified'; return rerender();
      case 'diff-swap': [S.diffA, S.diffB, S.diffNameA, S.diffNameB] = [S.diffB, S.diffA, S.diffNameB, S.diffNameA]; S.diffExpanded = []; recordSoon(); return rerender();
      case 'diff-clear': Object.assign(S, { diffA: '', diffB: '', diffNameA: '', diffNameB: '', diffExpanded: [], diffHunk: -1 }); return rerender();
      case 'diff-prev': return goTo(S, S.diffHunk < 0 ? -1 : S.diffHunk - 1);
      case 'diff-next': return goTo(S, S.diffHunk + 1);
      case 'diff-copy-patch': { copyText(unifiedPatch(S._rows || [], { aName: S._names?.[0], bName: S._names?.[1], context: CONTEXT })); t.textContent = 'Copied'; setTimeout(() => { t.textContent = 'Copy patch'; }, 900); return; }
      case 'diff-load-a': case 'diff-load-b': {
        const res = await api.openTextFile(); if (!res?.ok) return;
        const side = id.endsWith('a') ? 'A' : 'B';
        S[`diff${side}`] = res.content; S[`diffName${side}`] = baseName(res.filePath); S.diffExpanded = []; S.diffHunk = -1;
        recordSoon(); return rerender();
      }
      case 'diff-paste-a': case 'diff-paste-b': {
        let text = ''; try { text = await navigator.clipboard.readText(); } catch { return; }
        const side = id.endsWith('a') ? 'A' : 'B';
        S[`diff${side}`] = text; S[`diffName${side}`] = 'clipboard'; S.diffExpanded = []; S.diffHunk = -1;
        recordSoon(); return rerender();
      }
      case 'folder-swap': [S.folderPathA, S.folderPathB] = [S.folderPathB, S.folderPathA]; S.folderResult = null; return rerender();
      case 'browse-a': case 'browse-b': {
        const p = await api.pickFolder();
        if (p) { S[id === 'browse-a' ? 'folderPathA' : 'folderPathB'] = p; rerender(); }
        return;
      }
      case 'folder-compare': return runFolderCompare(ctx);
    }
  },
  onChange(el, { S, rerender }) {
    const flags = { 'diff-ignore-ws': 'diffIgnoreWs', 'diff-ignore-case': 'diffIgnoreCase', 'diff-sort-keys': 'diffSortKeys', 'diff-only-changes': 'diffOnlyChanges' };
    if (flags[el.id]) { S[flags[el.id]] = el.checked; S.diffExpanded = []; S.diffHunk = -1; return rerender(); }
    if (el.id === 'diff-format') { S.diffFormat = el.value; S.diffExpanded = []; S.diffHunk = -1; rerender(); }
  },
};
