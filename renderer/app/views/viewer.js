// Response body viewer: Pretty / Tree / Raw / Preview, a JSONPath filter, search with match
// stepping, wrap toggle, and Save / Open for any body (binary ones arrive as base64, see main/http.js).
// The options live in S.respView and apply to every response pane; typing in the filter or search
// box re-renders only the viewer bodies (refreshViewers), so the inputs keep focus.
import { esc } from '../../shared/html.js';
import { prettyJson } from '../../shared/json.js';
import { highlight, langFor } from '../../shared/highlight.js';
import { query } from '../jsonpath.js';
import { S } from '../store.js';

const MAX_LINES = 5000;   // longer bodies show this many lines until "Show all"
const TREE_CHILDREN = 500; // per object / array in the tree

const contentType = (res) => res.headers?.['content-type'] || '';
const parseJson = (body) => { try { return { ok: true, value: JSON.parse(body) }; } catch { return { ok: false }; } };

export function previewKind(res) {
  const t = contentType(res);
  if (res.binary && /^image\//i.test(t)) return 'image';
  if (res.binary && /pdf/i.test(t)) return 'pdf';
  if (!res.binary && /^image\/svg/i.test(t)) return 'svg';
  if (!res.binary && /html/i.test(t)) return 'html';
  return null;
}

const slotAttr = (slot) => (slot == null ? '' : ` data-slot="${esc(slot)}"`);

export function viewerHtml(res, slot) {
  const v = S.respView, json = !res.binary && parseJson(res.body).ok, kind = previewKind(res);
  const modes = [['pretty', 'Pretty'], ...(json ? [['tree', 'Tree']] : []), ['raw', 'Raw'], ...(kind ? [['preview', 'Preview']] : [])];
  const mode = res.binary ? 'preview' : modes.some(([m]) => m === v.mode) ? v.mode : 'pretty';
  const bar = res.binary ? '' : `${modes.map(([m, label]) => `<button class="tab${m === mode ? ' active' : ''}" data-action="view-mode" data-mode="${m}">${label}</button>`).join('')}
      ${json && mode !== 'preview' ? `<input type="text" class="view-filter" value="${esc(v.filter)}" placeholder="Filter: $.items[*].id" spellcheck="false" title="JSONPath: $.a.b, [0], [-1], [*], ..key, [?(@.price &lt; 10)]"/>` : ''}
      ${mode !== 'preview' ? `<input type="text" class="view-search" value="${esc(v.search)}" placeholder="Search" spellcheck="false"/>
        <span class="hint view-count"></span>
        <button class="btn-ghost small" data-action="view-step" data-dir="-1" title="Previous match (Shift+Enter)">▲</button><button class="btn-ghost small" data-action="view-step" data-dir="1" title="Next match (Enter)">▼</button>
        <button class="btn-ghost small${v.wrap ? ' active' : ''}" data-action="view-wrap" title="Wrap long lines">Wrap</button>` : ''}`;
  return `<div class="viewer"${slotAttr(slot)}>
    <div class="viewer-bar">${bar}<span class="spacer"></span>
      ${kind === 'pdf' || kind === 'html' || res.binary ? `<button class="btn-ghost small" data-action="view-open"${slotAttr(slot)} title="Open in the default app">Open ↗</button>` : ''}
      <button class="btn-ghost small" data-action="view-save"${slotAttr(slot)} title="Save the body to a file">Save…</button></div>
    <div class="viewer-body" data-mode="${mode}"${slotAttr(slot)}>${viewerBody(res, mode)}</div></div>`;
}

export function viewerBody(res, mode) {
  const v = S.respView;
  if (mode === 'preview') return previewHtml(res);
  const parsed = parseJson(res.body);
  let value = parsed.value, text = res.body, lang = parsed.ok ? 'json' : langFor(contentType(res));
  if (parsed.ok && v.filter.trim()) {
    try {
      const hits = query(parsed.value, v.filter);
      value = hits.length === 1 ? hits[0] : hits;
      text = JSON.stringify(value, null, 2);
      if (!hits.length) return '<p class="hint">No matches for that filter.</p>';
    } catch (err) { return `<p class="error-text">${esc(err.message)}</p>`; }
  } else if (mode === 'pretty' && parsed.ok) text = prettyJson(res.body);
  if (mode === 'tree' && parsed.ok) return `<div class="json-tree">${treeHtml(value, null, 0, v.search.trim().toLowerCase())}</div>`;
  const lines = text.split('\n');
  const cut = !v.full && lines.length > MAX_LINES;
  if (cut) text = lines.slice(0, MAX_LINES).join('\n');
  const q = v.search;
  const html = q ? markMatches(text, q) : mode === 'raw' ? esc(text) : highlight(text, lang);
  return `<pre class="resp-body${v.wrap ? '' : ' nowrap'}">${html}</pre>
    ${cut ? `<p class="hint">Showing the first ${MAX_LINES.toLocaleString()} of ${lines.length.toLocaleString()} lines. <button class="link-btn" data-action="view-full">Show all</button> (may be slow)</p>` : ''}`;
}

function markMatches(text, q) {
  const lower = text.toLowerCase(), needle = q.toLowerCase();
  let out = '', i = 0;
  for (let at = lower.indexOf(needle); at >= 0 && needle; at = lower.indexOf(needle, i)) {
    out += esc(text.slice(i, at)) + `<mark class="view-hit">${esc(text.slice(at, at + needle.length))}</mark>`;
    i = at + needle.length;
  }
  return out + esc(text.slice(i));
}

const mark = (s, q) => (q ? markMatches(s, q) : esc(s));

// Collapsible JSON tree: the first two levels start open; nodes holding a search match open too.
function treeHtml(value, key, depth, q) {
  const label = key == null ? '' : `<span class="json-key">${mark(typeof key === 'number' ? String(key) : JSON.stringify(key), q)}</span>: `;
  if (value === null || typeof value !== 'object') {
    const cls = value === null ? 'json-null' : typeof value === 'string' ? 'json-str' : typeof value === 'number' ? 'json-num' : 'json-bool';
    return `<div class="tree-leaf">${label}<span class="${cls}">${mark(JSON.stringify(value), q)}</span></div>`;
  }
  const entries = Array.isArray(value) ? value.map((x, i) => [i, x]) : Object.entries(value);
  const [o, c] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  if (!entries.length) return `<div class="tree-leaf">${label}${o}${c}</div>`;
  const open = depth < 2 || (q && JSON.stringify(value).toLowerCase().includes(q));
  const shown = entries.slice(0, TREE_CHILDREN).map(([k, x]) => treeHtml(x, k, depth + 1, q)).join('');
  const more = entries.length > TREE_CHILDREN ? `<div class="hint">… ${entries.length - TREE_CHILDREN} more (use the filter, e.g. <code>[${TREE_CHILDREN}:]</code>)</div>` : '';
  return `<details class="tree-node"${open ? ' open' : ''}><summary>${label}${o}<span class="hint tree-count">${entries.length} ${Array.isArray(value) ? 'items' : 'keys'}</span></summary>
    <div class="tree-children">${shown}${more}</div><div class="tree-close">${c}</div></details>`;
}

function previewHtml(res) {
  const kind = previewKind(res), t = contentType(res);
  if (kind === 'image') return `<img class="viewer-img" alt="Response image" src="data:${esc(t.split(';')[0])};base64,${res.bodyBase64}"/>`;
  if (kind === 'svg') return `<img class="viewer-img" alt="Response image" src="data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(res.body)))}"/>`;
  // Sandboxed with no permissions: no scripts, no forms, no navigation of this window.
  if (kind === 'html') return `<iframe class="viewer-frame" sandbox="" title="HTML preview" srcdoc="${esc(res.body)}"></iframe>`;
  if (kind === 'pdf') return `<p class="hint">PDF, ${(res.size / 1024).toFixed(1)} KB. Use <b>Open ↗</b> to view it, or <b>Save…</b>.</p>`;
  return `<p class="hint">Binary body (${esc(t || 'no content type')}, ${(res.size / 1024).toFixed(1)} KB). Use <b>Save…</b> or <b>Open ↗</b>.</p>`;
}

// Re-renders the bodies of every viewer on screen; responseFor maps a data-slot to its response.
export function refreshViewers(responseFor) {
  for (const body of document.querySelectorAll('.viewer-body')) {
    const res = responseFor(body.dataset);
    if (res) body.innerHTML = viewerBody(res, body.dataset.mode);
  }
  stepMatch(0);
}

// Moves the current search match (dir: -1 / 0 / 1) and updates the counters.
export function stepMatch(dir) {
  const hits = [...document.querySelectorAll('.viewer-body mark.view-hit')];
  const cur = hits.findIndex((h) => h.classList.contains('current'));
  for (const h of hits) h.classList.remove('current');
  const next = hits.length ? (cur < 0 ? 0 : (cur + dir + hits.length) % hits.length) : -1;
  if (next >= 0) { hits[next].classList.add('current'); if (dir) hits[next].scrollIntoView({ block: 'center' }); }
  for (const c of document.querySelectorAll('.view-count')) c.textContent = S.respView.search ? (hits.length ? `${next + 1}/${hits.length}` : '0/0') : '';
}

// File name for Save / Open: the request's name and an extension from the content type.
export function bodyFileName(res, name = 'response') {
  const t = contentType(res).split(';')[0].trim().toLowerCase();
  const ext = { 'application/json': 'json', 'application/xml': 'xml', 'text/xml': 'xml', 'text/html': 'html', 'text/csv': 'csv', 'text/plain': 'txt', 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/zip': 'zip' }[t]
    || (/\+json$/.test(t) ? 'json' : /\+xml$/.test(t) ? 'xml' : res.binary ? 'bin' : 'txt');
  return `${String(name).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'response'}.${ext}`;
}
