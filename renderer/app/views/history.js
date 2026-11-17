// History: the sidebar list (when S.sidebarMode === 'history') and the entry page (S.page === 'history').
import { $, esc } from '../../shared/html.js';
import { isJson, prettyJson } from '../../shared/json.js';
import { S, findReq, project } from '../store.js';
import { historyEntries, historyEntry, matchesQuery, groupByDay } from '../history.js';
import { CHANGE_KINDS, nameSuggestions } from '../replay.js';
import { diffHtml } from '../../shared/diff.js';
import { responseHtml } from './response.js';
import { icon } from '../../shared/icons.js';

const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Path + query for the list (host is in the tooltip); the raw text when it isn't a parseable URL.
function shortUrl(url) {
  try { const u = new URL(url); return { short: u.pathname + u.search || '/', host: u.host }; } catch { return { short: url, host: '' }; }
}

function statusHtml(e) {
  if (e.error) return `<span class="history-status err" title="${esc(e.error)}">ERR</span>`;
  return `<span class="history-status ${e.response.status < 400 ? 'ok' : 'err'}">${e.response.status}</span>`;
}

function rowHtml(e) {
  const { short, host } = shortUrl(e.url);
  const active = S.page === 'history' && S.history.id === e.id;
  return `<div class="sidebar-item history-item${active ? ' active' : ''}" data-action="history-open" data-id="${esc(e.id)}"
      title="${esc(`${e.method} ${e.url}\n${host ? host + ' · ' : ''}${e.reqName} · ${new Date(e.at).toLocaleString()}`)}">
    <span class="method-tag m-${esc(e.method)}">${esc(e.method)}</span><span class="item-name">${e.replayOf ? `<span class="hint" title="${esc('Re-sent: ' + (e.change || ''))}">↻ </span>` : ''}${esc(short)}</span>${statusHtml(e)}<span class="hint">${fmtClock(e.at)}</span></div>`;
}

// Only the list re-renders while typing in the search box, so the box keeps focus.
export function renderHistoryList() {
  const all = historyEntries();
  const shown = S.history.filter.trim() ? all.filter((e) => matchesQuery(e, S.history.filter)) : all;
  $('history-list').innerHTML = shown.length
    ? groupByDay(shown).map((g) => `<div class="history-day">${esc(g.label)}</div>${g.entries.map(rowHtml).join('')}`).join('')
    : `<div class="pad-10 hint">${all.length ? 'No matches' : 'Nothing sent yet'}</div>`;
  $('history-count').textContent = all.length ? `${shown.length === all.length ? all.length : `${shown.length} of ${all.length}`} request${all.length === 1 ? '' : 's'}` : '';
}

const headerLines = (h) => Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join('\n');

// The body as sent: text, multipart parts (files by path), or the file sent as the body.
export function sentBodyText(req) {
  if (req?.parts?.length) return req.parts.map((p) => (p.file != null ? `${p.name}: @${p.file}${p.contentType ? ` (${p.contentType})` : ''}` : `${p.name}: ${p.value ?? ''}`)).join('\n');
  if (req?.file) return `@${req.file}`;
  return req?.body ? (isJson(req.body) ? prettyJson(req.body) : req.body) : '';
}

// ---- Send again with one change (replay.js; actions in actions/history.js)
const PLACEHOLDER = { header: ['Header, e.g. Authorization', 'new value'], query: ['Parameter', 'new value'], body: ['Field, e.g. items[0].qty', 'new value (JSON: 5, true, null, "text")'] };

function replayFormHtml(e, loc) {
  const R = S.history.replay;
  const p = loc?.p || project(e.projectId);
  const kinds = CHANGE_KINDS.map(([k, label]) => `<option value="${k}" ${R.kind === k ? 'selected' : ''}>${label}</option>`).join('');
  let fields = '';
  if (PLACEHOLDER[R.kind]) {
    const names = nameSuggestions(e, R.kind);
    fields = `<input type="text" id="replay-name" list="replay-names" value="${esc(R.name)}" placeholder="${esc(PLACEHOLDER[R.kind][0])}" spellcheck="false" class="grow"/>
      <datalist id="replay-names">${names.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
      <input type="text" id="replay-value" value="${esc(R.value)}" placeholder="${esc(PLACEHOLDER[R.kind][1])}" spellcheck="false" class="grow" ${R.remove ? 'disabled' : ''}/>
      <label class="hint"><input type="checkbox" id="replay-remove" ${R.remove ? 'checked' : ''}/> remove it</label>`;
  } else if (R.kind === 'env') {
    fields = loc
      ? `<select id="replay-env" class="grow">${(p?.envs || []).map((x) => `<option value="${esc(x.id)}" ${x.id === (R.envId || p.activeEnv) ? 'selected' : ''}>${esc(x.name)}${x.id === p.activeEnv ? ' (active)' : ''}</option>`).join('')}</select>
         <span class="hint">sends the saved request as it is now</span>`
      : '<span class="hint">Only for entries whose request still exists.</span>';
  }
  const disabled = R.running || (R.kind === 'env' && (!loc || !p?.envs.length));
  return `<section class="replay-box mb-14"><h4 class="section-title">Send again with one change</h4>
    <div class="spec-row"><select id="replay-kind">${kinds}</select>${fields}
      <button class="btn-primary small" data-action="replay-send" ${disabled ? 'disabled' : ''}>${R.running ? 'Sending…' : 'Send'}</button></div>
    <p class="hint">Sends what was recorded with only that changed, then compares the response with this one. Nothing saved is changed; the new send goes into History.</p>
    ${R.result && R.result.baseId === e.id ? replayResultHtml(e, R.result) : ''}</section>`;
}

const cell = (a, b, fmt = (x) => x, mark = true) => `<td>${esc(a == null ? '—' : fmt(a))}</td><td class="${mark && a !== b ? 'diff-add' : ''}">${esc(b == null ? '—' : fmt(b))}</td>`;

function replayResultHtml(e, out) {
  const { res, cmp, notes = [], entryId, change } = out;
  // Errors first; warnings (e.g. an undocumented status) count too, or a crash would read "matches".
  const issues = [...(res.validation?.response || [])].sort((x, y) => (x.level === 'error' ? 0 : 1) - (y.level === 'error' ? 0 : 1));
  const specClass = issues.some((i) => i.level === 'error') ? 'assert-fail' : issues.length ? 'warn-text' : 'assert-pass';
  const asserts = res.assertionResults || [];
  const failedAsserts = asserts.filter((a) => !a.ok).length;
  const head = `<div class="mt-10 mb-8"><b>${esc(change)}</b>${entryId ? ` · <button class="link-btn" data-action="history-open" data-id="${esc(entryId)}">open the new entry</button>` : ''}</div>
    ${notes.map((n) => `<p class="warn-text">⚠ ${esc(n)}</p>`).join('')}`;
  if (res.error) return `${head}<p class="assert-fail">✗ ${esc(res.error)}</p>`;
  const R = S.history.replay;
  const diff = diffHtml(cmp.rows, { numbers: true, context: 3, expanded: new Set(R.open || []) }).replace(/data-gap="/g, 'data-action="replay-gap" data-gap="');
  const fieldRows = (cmp.fields || []).slice(0, 200).map((f) => `<tr><td><code>${esc(f.path)}</code></td><td class="hint">${f.kind}</td><td class="diff-del">${esc(f.a)}</td><td class="diff-add">${esc(f.b)}</td></tr>`).join('');
  return `${head}
    <table class="run-table ab-table mb-8"><tr><th></th><th>Recorded</th><th>Now, with the change</th></tr>
      <tr><td>Status</td>${cell(cmp.status[0], cmp.status[1])}</tr>
      <tr><td>Time</td>${cell(cmp.time[0], cmp.time[1], (t) => `${t} ms`, false)}</tr>
      ${cmp.headers.map((h) => `<tr class="ab-diff"><td><code>${esc(h.name)}</code></td>${cell(h.a, h.b)}</tr>`).join('')}
      ${asserts.length ? `<tr><td>Assertions</td><td class="hint">—</td><td class="${failedAsserts ? 'assert-fail' : 'assert-pass'}">${failedAsserts ? `${failedAsserts} of ${asserts.length} failed` : `all ${asserts.length} pass`}</td></tr>` : ''}
      ${res.validation?.op ? `<tr><td>Spec</td><td class="hint">—</td><td class="${specClass}">${issues.length ? esc(issues.slice(0, 3).map((i) => `${i.where} ${i.message}`).join(' · ')) : '✓ matches'}</td></tr>` : ''}</table>
    ${cmp.bodySame ? '<p class="assert-pass">Same body as recorded.</p>'
      : `${fieldRows ? `<table class="diff-fields mb-8">${fieldRows}</table>` : ''}
        <div class="hint mb-6">Body: ${cmp.stats.removed} line${cmp.stats.removed === 1 ? '' : 's'} removed, ${cmp.stats.added} added</div>
        <pre class="resp-body nowrap">${diff}</pre>`}`;
}

// The response in the shape responseHtml() expects.
export const historyResponse = (e) => (e.error ? { error: e.error } : { ...e.response, requestData: { method: e.method, url: e.url, ...e.request } });

export function historyPageHtml() {
  const e = historyEntry(S.history.id);
  if (!e) return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button><h3>History</h3></div><p class="hint">This entry no longer exists.</p>`;
  const loc = e.reqId && findReq(e.reqId);
  const sent = sentBodyText(e.request);
  const body = sent ? '\n\n' + sent : '';
  const base = e.replayOf && historyEntry(e.replayOf);
  const truncated = e.request.truncated || e.response?.truncated;
  return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button>
      <h3><span class="method-tag m-${esc(e.method)}">${esc(e.method)}</span> ${esc(e.url)}</h3></div>
    <div class="mb-8 hint">${esc(new Date(e.at).toLocaleString())} · from ${loc ? `"${esc(loc.r.name)}" in ${esc(loc.p.name)}` : `"${esc(e.reqName)}" (since deleted)`}
      ${e.replayOf ? ` · re-sent ${esc(e.change || '')}${base ? ` from <button class="link-btn" data-action="history-open" data-id="${esc(base.id)}">the entry at ${esc(new Date(base.at).toLocaleTimeString())}</button>` : ''}` : ''}</div>
    <div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap">
      ${loc ? '<button class="btn-ghost small" data-action="history-open-req">Open request</button>' : ''}
      <button class="btn-ghost small" data-action="history-save-as" title="Create a request from exactly what was sent">Save as request…</button>
      <button class="btn-ghost small" data-action="history-curl">Copy as cURL</button>
      <button class="btn-ghost small" data-action="history-delete">Delete entry</button></div>
    ${truncated ? '<p class="mb-8 warn-text">⚠ A body over 100 KB was truncated when history was saved.</p>' : ''}
    ${replayFormHtml(e, loc)}
    <h4 class="section-title">Request (as sent)</h4>
    <pre class="mb-14 resp-body">${esc(`${e.method} ${e.url}\n${headerLines(e.request.headers)}${body}`)}</pre>
    <h4 class="section-title">Response</h4>
    <div>${responseHtml(historyResponse(e), [], 'history', S.history.resTab)}</div>`;
}
