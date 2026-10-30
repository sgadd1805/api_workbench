// Log rendering shared by the Tasks page (renderer/app/views/tasks.js), a response's Logs tab and the
// popped-out log windows (renderer/logs/main.js): live log entries, the search form and search results.
import { esc } from './html.js';
import { icon } from './icons.js';

export const STATE_LABEL = { starting: '⏳ starting', ready: '● ready', stopping: '… stopping', stopped: '○ stopped', failed: '✗ failed' };
export const LEVEL_RANK = { TRACE: 0, DEBUG: 1, INFO: 2, '': 2, STDERR: 3, WARN: 3, ERROR: 4, FATAL: 4 };

export const stateChip = (state) => `<span class="task-state ${esc(state)}">${STATE_LABEL[state] || esc(state)}</span>`;

// Log lines grouped into entries (a line plus its stack-trace continuation lines, folded).
export function logEntriesHtml(list, { filter = '', minLevel = 'all', highlight = [] } = {}) {
  const entries = [];
  for (const l of list) { if (l.cont && entries.length) entries[entries.length - 1].push(l); else entries.push([l]); }
  const q = filter.trim().toLowerCase();
  const min = minLevel === 'all' ? -1 : LEVEL_RANK[minLevel];
  const marks = highlight.filter(Boolean);
  const mark = (text) => { let h = esc(text); for (const m of marks) h = h.split(esc(m)).join(`<mark>${esc(m)}</mark>`); return h; };
  const shown = entries.filter((e) => (min < 0 || (LEVEL_RANK[e[0].level] ?? 2) >= min) && (!q || e.some((l) => l.text.toLowerCase().includes(q))));
  if (!shown.length) return `<div class="pad-8 hint">${list.length ? 'No matching lines' : 'No output yet'}</div>`;
  return shown.slice(-2000).map(([first, ...rest]) => {
    const cls = `log-line lvl-${(first.level || 'none').toLowerCase()}`;
    if (!rest.length) return `<div class="${cls}">${mark(first.text)}</div>`;
    return `<details class="${cls} log-entry"${/ERROR|FATAL/.test(first.level) ? '' : ''}><summary>${mark(first.text)} <span class="hint">(+${rest.length} lines)</span></summary>${rest.map((l) => `<div>${mark(l.text)}</div>`).join('')}</details>`;
  }).join('');
}


// The log search form (ids ls-q, ls-q-*). opts: { hasWindow (show the time window), scopes: [{ value, label }]
// or null (no scope picker), scope, disabled }
export function searchFormHtml(q, { hasWindow = false, scopes = null, scope = '', disabled = false } = {}) {
  return `<div class="log-search-form">
    <div class="spec-row"><input type="text" id="ls-q" value="${esc(q.pattern)}" placeholder="Search text, e.g. a request id, an exception, a user id" spellcheck="false" class="grow mono"/>
      ${q.running ? '<button class="btn-primary danger small" data-action="log-search-cancel">Cancel</button>' : `<button class="btn-primary small" data-action="log-search" ${disabled ? 'disabled' : ''}>${icon('search')} Search</button>`}</div>
    <div class="spec-row wrap">
      <label class="hint"><input type="checkbox" id="ls-q-regex" ${q.regex ? 'checked' : ''}/> Regular expression</label>
      <label class="hint"><input type="checkbox" id="ls-q-icase" ${q.ignoreCase ? 'checked' : ''}/> Ignore case</label>
      <label class="hint" for="ls-q-context">Context</label><select id="ls-q-context">${[0, 2, 5, 10].map((n) => `<option value="${n}" ${q.context === n ? 'selected' : ''}>${n} lines</option>`).join('')}</select>
      ${hasWindow ? `<label class="hint" for="ls-q-since">Window</label><select id="ls-q-since" title="Kubernetes / Docker logs: how far back">${[['15m', 'last 15 min'], ['1h', 'last hour'], ['6h', 'last 6 hours'], ['24h', 'last day'], ['168h', 'last 7 days'], ['', 'everything kept']].map(([v, l]) => `<option value="${v}" ${q.since === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
      <label class="hint" for="ls-q-max">Max</label><select id="ls-q-max">${[100, 200, 1000].map((n) => `<option ${q.max === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
      ${scopes ? `<label class="hint" for="ls-q-scope">In</label><select id="ls-q-scope">${scopes.map((o) => `<option value="${esc(o.value)}" ${o.value === scope ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : ''}</div></div>`;
}

function markText(text, q) {
  if (!q.pattern) return esc(text);
  let re;
  try { re = new RegExp(q.regex ? q.pattern : q.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), q.ignoreCase ? 'gi' : 'g'); } catch { return esc(text); }
  let out = '', last = 0;
  for (const m of text.matchAll(re)) { if (!m[0]) break; out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`; last = m.index + m[0].length; }
  return out + esc(text.slice(last));
}

// results: [{ name, hits, truncated, error, command, ms }]
export function searchResultsHtml(results, q) {
  if (!results.length) return '';
  const line = (l, cls, text) => `<div class="log-hit-line ${cls}"><span class="log-hit-n">${l.line ?? ''}</span><span class="log-hit-text">${text}</span></div>`;
  return results.map((r) => {
    const byFile = new Map();
    for (const h of r.hits || []) { if (!byFile.has(h.file)) byFile.set(h.file, []); byFile.get(h.file).push(h); }
    const head = `<div class="log-hits-head"><b>${esc(r.name)}</b> <span class="${r.hits?.length ? 'status-ok' : 'hint'}">${r.running ? 'searching…' : `${r.hits?.length || 0}${r.truncated ? '+' : ''} match${r.hits?.length === 1 ? '' : 'es'}`}</span>
      ${r.ms != null ? `<span class="hint">${r.ms} ms</span>` : ''}${r.command ? `<span class="hint mono log-hits-cmd" title="${esc(r.command)}">${esc(r.command)}</span>` : ''}</div>`;
    const err = r.error ? `<div class="error-text">${esc(r.error)}</div>` : '';
    const files = [...byFile].map(([file, hits]) => `<div class="log-hits-file"><div class="hint mono">${esc(file)}</div>${hits.slice(0, 500).map((h) =>
      `<div class="log-hit">${h.before.map((b) => line(b, 'ctx', esc(b.text))).join('')}${line(h, 'match', markText(h.text, q))}${h.after.map((a) => line(a, 'ctx', esc(a.text))).join('')}</div>`).join('')}</div>`).join('');
    return `<section class="log-hits">${head}${err}${files}${r.truncated ? `<p class="hint">Stopped at ${q.max} matches; narrow the search or raise Max.</p>` : ''}</section>`;
  }).join('');
}
