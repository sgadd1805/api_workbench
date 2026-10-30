import { $, esc } from '../../shared/html.js';
import { prettyJson } from '../../shared/json.js';
import { lineDiff, diffHtml, sortedJson } from '../../shared/diff.js';
import { capturedDiff } from '../capture.js';
import { DB, S, activeTab, findReq } from '../store.js';
import { hitsDuring } from '../logwatch.js';
import { traceHtml } from './trace.js';
import { traceSpans } from '../actions/otel.js';
import { runsFor } from '../history.js';
import { sparklineHtml, slowBadgeHtml, trendSectionHtml } from './trend.js';
import { validationHtml } from './specs.js';
import { timingHtml, timingTitle } from './timing.js';
import { logEntriesHtml, searchResultsHtml } from './tasks.js';
import { viewerHtml } from './viewer.js';
import { ignoreRulesFor } from '../snapshot.js';
import { streamPanelHtml } from './kinds.js';
import { kindOf } from '../store.js';

const byteSize = (s) => new TextEncoder().encode(s).length;
const fmtSize = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const statusClass = (status) => (status < 400 ? 'status-ok' : 'status-err');

const headersHtml = (res) => `<pre class="resp-body">${esc(Object.entries(res.headers || {}).map(([k, v]) => k + ': ' + v).join('\n'))}</pre>`;

// Earlier successful runs of the open request, and a diff of the latest one against the chosen one.
function historyHtml() {
  const loc = S.req && findReq(S.req.id);
  const env = loc?.p.envs.find((e) => e.id === loc.p.activeEnv);
  const trend = loc ? trendSectionHtml(loc.r.id, loc.p.activeEnv, { allEnvs: !!activeTab()?.trendAllEnvs, envName: env?.name || 'No environment' }) : '';
  const runs = runsFor(S.req?.id);
  const historyBase = activeTab()?.historyBase ?? 1;
  if (runs.length < 2) return trend + '<p class="hint">Send this request again to compare runs. The last 10 are compared here; every send is also in the sidebar\'s History panel.</p>';
  const base = runs[Math.min(historyBase, runs.length - 1)];
  const list = runs.map((run, i) => `<div class="history-run${run === base ? ' active' : ''}${i === 0 ? ' current' : ''}" ${i ? `data-action="history-base" data-idx="${i}"` : ''}>
      <span class="${statusClass(run.status)}">${run.status}</span><span class="hint">${fmtTime(run.at)}</span>
      <span class="hint">${run.time} ms</span><span class="hint">${fmtSize(byteSize(run.body))}</span>${i === 0 ? '<span class="hint">(latest)</span>' : ''}</div>`).join('');
  const rows = lineDiff(prettyJson(base.body), prettyJson(runs[0].body));
  const changed = rows.some((r) => r.type !== 'same');
  return `${trend}<div class="history-list">${list}</div>
    <div class="hint" style="margin:8px 0 4px">Diff: run at ${fmtTime(base.at)} → latest${changed ? '' : ' (bodies identical)'}</div>
    <pre class="resp-body">${diffHtml(rows)}</pre>`;
}

// "vs captured": this live response next to the one the login window captured for this request (r.captured):
// the status, JSON field changes, and a diff with unchanged lines folded (click a fold to open it).
function capturedHtml(res) {
  const c = S.req?.captured; if (!c) return '';
  const d = res.capturedDiff || capturedDiff(c, res);
  const when = new Date(c.at).toLocaleString();
  if (!d) return '<p class="hint">Nothing to compare: this send failed.</p>';
  if (d.same) return `<p class="assert-pass">Same as the response captured ${esc(when)}.</p>`;
  const pretty = (t) => { try { return sortedJson(t); } catch { return t || ''; } };
  const tab = activeTab();
  const rows = lineDiff(pretty(c.body), pretty(res.body ?? ''), { ignoreWhitespace: true });
  const diff = diffHtml(rows, { numbers: true, context: 3, expanded: new Set(tab?.capturedOpen || []) }).replace(/data-gap="/g, 'data-action="captured-gap" data-gap="');
  return `<p class="hint">Captured ${esc(when)}${c.truncated ? ' (its body was cut at 100 KB)' : ''} → this response. Keys are sorted, so order doesn't count.</p>
    ${d.status ? `<p class="assert-fail">Status ${d.status[0]} → ${d.status[1]}</p>` : ''}
    ${d.fields?.length ? `<table class="diff-fields mb-8">${d.fields.slice(0, 200).map((f) => `<tr><td><code>${esc(f.path)}</code></td><td class="hint">${f.kind}</td><td class="diff-del">${esc(f.a)}</td><td class="diff-add">${esc(f.b)}</td></tr>`).join('')}</table>` : ''}
    <pre class="resp-body nowrap">${diff}</pre>`;
}

// Server log lines carrying this response's correlation ids (loaded by the restab action; see actions/response.js).
// Search in the project's server log sources (SSH / Kubernetes / Docker / files) for this request's ids.
function serverSearchHtml(res) {
  const s = res.serverLogs;
  const btn = `<button class="btn-ghost small" data-action="logs-search-servers" ${s?.running ? 'disabled' : ''} title="Search the project's server log sources for this request's ids (last hour)">${s?.running ? 'Searching servers…' : 'Search server logs'}</button>`;
  return `<div class="mt-8">${btn}</div>${s ? searchResultsHtml(s.results, s.query) : ''}`;
}

// Lines the project's log watch flagged while this request ran (logwatch.js).
function flaggedDuring(res) {
  const loc = S.req && findReq(S.req.id);
  return loc && res.ranFrom ? hitsDuring(loc.p.id, res.ranFrom, res.ranTo) : [];
}

function flaggedHtml(res) {
  const list = flaggedDuring(res);
  if (!list.length) return '';
  return `<div class="log-flagged-during"><h4 class="section-title assert-fail">⚠ ${list.length} flagged log line${list.length === 1 ? '' : 's'} while this ran</h4>
    ${list.slice(0, 50).map((h) => `<div class="log-flag"><span class="hint">${new Date(h.at).toLocaleTimeString()}</span><b>${esc(h.sourceName)}</b><span class="log-flag-rule">${esc(h.rule)}</span><span class="mono log-flag-text">${esc(h.text)}</span></div>`).join('')}</div>`;
}

function logsHtml(res) {
  return flaggedHtml(res) + logsHtmlBody(res);
}

function logsHtmlBody(res) {
  const c = res.correlation;
  if (!c) return '<p class="hint">This request wasn\'t tagged with correlation ids (turned off in Project settings).</p>';
  return liveLogsHtml(res, c) + serverSearchHtml(res);
}

function liveLogsHtml(res, c) {
  const ids = `<p class="mb-6 hint">Lines containing <code>${esc(c.requestId)}</code> or trace <code>${esc(c.traceId)}</code>
    <button class="btn-ghost small" data-action="logs-refresh">Refresh</button>${res.traceLink ? ` <a href="${esc(res.traceLink)}" target="_blank" rel="noopener">Open trace ↗</a>` : ''}</p>`;
  const m = res.logMatches;
  if (!m || m.loading) return ids + '<p class="hint">Searching logs…</p>';
  if (!m.sources) return ids + '<p class="hint">No tasks or log sources for this project. Add them under Project → Tasks &amp; logs, and have the server log the <code>X-Request-Id</code> / trace id (e.g. via MDC).</p>';
  if (!m.groups.length) return ids + `<p class="hint">No lines yet in ${m.sources} log source(s). Logs can lag a moment — Refresh — or the server may not log these ids.</p>`;
  return ids + m.groups.map((g) => `<h4 class="section-title">${esc(g.name)} <span class="hint">${g.lines.length} lines</span></h4>
    <div class="log-view small">${logEntriesHtml(g.lines, { highlight: [c.requestId, c.traceId] })}</div>`).join('');
}

// The Snapshot tab: save this response as the expected one, or see how it differs and pick fields to ignore.
function snapshotHtml(res) {
  const r = S.req, snap = r?.snapshot;
  if (!snap) return `<p class="hint">Save a response as this request's snapshot; later responses are compared with it field by field, and a difference fails the collection runner.
      Volatile fields (ids, timestamps) can be ignored.</p><button class="btn-primary small" data-action="snap-save">Save this response as the snapshot</button>`;
  const result = res.snapshotResult;
  const rows = (result?.diffs || []).slice(0, 300).map((d) => {
    const rules = ignoreRulesFor(d.path);
    return `<tr class="snap-${d.kind}"><td><code>${esc(d.path)}</code></td><td class="hint">${d.kind}</td><td><code>${esc(d.expected)}</code></td><td><code>${esc(d.actual)}</code></td>
      <td>${d.kind === 'status' || d.kind === 'text' ? '' : `<button class="btn-ghost small" data-action="snap-ignore" data-rule="${esc(rules.exact)}" title="Ignore ${esc(rules.exact)}">Ignore</button>${rules.key ? `<button class="btn-ghost small" data-action="snap-ignore" data-rule="${esc(rules.key)}" title="Ignore every field named ${esc(rules.key)}">all "${esc(rules.key)}"</button>` : ''}`}</td></tr>`;
  }).join('');
  return `<div class="spec-row"><span class="${result?.matches ? 'assert-pass' : 'assert-fail'}">${!result ? 'Not compared (no response body)' : result.matches ? `✓ Matches the snapshot${result.ignored ? ` (${result.ignored} ignored field${result.ignored === 1 ? '' : 's'})` : ''}` : `✗ ${result.diffs.length} difference${result.diffs.length === 1 ? '' : 's'} from the snapshot`}</span>
      <span class="hint">saved ${esc(new Date(snap.savedAt).toLocaleString())}</span><span class="grow"></span>
      <button class="btn-ghost small" data-action="snap-save" title="Make this response the expected one">Update snapshot</button>
      <button class="btn-ghost small" data-action="snap-remove">Remove</button></div>
    ${rows ? `<table class="run-table snap-table"><tr><th>Field</th><th></th><th>Expected</th><th>Now</th><th></th></tr>${rows}</table>` : ''}
    <label class="hint mt-8 block" for="snap-ignore">Ignored fields: names (<code>createdAt</code>) or paths (<code>$.items[*].id</code>, <code>$..traceId</code>), one per line</label>
    <textarea id="snap-ignore" rows="3" spellcheck="false">${esc((snap.ignore || []).join('\n'))}</textarea>`;
}

// slot: compare-mode column (0/1), so Copy/Trace act on that column's response rather than the active tab's.
// resTab: which pane to show. The History tab only exists in the main panel.
export function responseHtml(res, assertions, slot, resTab = 'body') {
  if (!res) return '<span class="hint">Send a request to see the response</span>';
  // An error has no body or headers, but the main panel still offers History (earlier successful runs).
  if (res.error) {
    const error = `<p class="error-text">${esc(res.error)}</p>${validationHtml(res.validation)}${res.scriptLogs?.length ? `<pre class="resp-body">${esc(res.scriptLogs.join('\n'))}</pre>` : ''}`;
    if (slot != null) return error;
    return `${error}<div class="tabs"><button class="tab${resTab === 'history' ? ' active' : ''}" data-action="restab" data-tab="history">History</button></div>
      ${resTab === 'history' ? historyHtml() : ''}`;
  }
  const slotAttr = slot == null ? '' : ` data-slot="${slot}"`;
  const spanCount = res.correlation ? traceSpans.get(res.correlation.traceId)?.length : 0;
  const vsCaptured = slot == null && S.req?.captured && !res.captured;
  const capturedCount = res.capturedDiff && !res.capturedDiff.same ? (res.capturedDiff.fields?.length || 1) : 0;
  const tabs = [['body', 'Body'], ['headers', 'Headers'], ['timing', 'Timing'], ...(slot == null ? [['trace', `Trace${spanCount ? ` <span class="hint">${spanCount}</span>` : ''}`], ['logs', 'Logs'], ['history', 'History'], ['snapshot', 'Snapshot']] : []),
    ...(vsCaptured ? [['captured', `vs captured${capturedCount ? ` <span class="hint">${capturedCount}</span>` : ' <span class="assert-pass">✓</span>'}`]] : [])];
  const tab = tabs.some(([id]) => id === resTab) ? resTab : 'body';
  const panes = { trace: (r) => traceHtml(r, traceSpans.get(r.correlation?.traceId) || [], { receiver: S.otel, traceLink: r.traceLink }), snapshot: snapshotHtml, body: viewerHtml, headers: headersHtml, timing: (r) => (r.captured ? `<p class="hint">Captured in the login window: only the total time (${r.time} ms) is known. Send the request to see each phase.</p>` : timingHtml(r.timing)), logs: logsHtml, history: historyHtml, captured: capturedHtml };
  return `<div class="status-line"><span class="${statusClass(res.status)}">${res.status} ${esc(res.statusText)}</span>
      ${res.captured ? '<span class="captured-badge" title="The response the login window got; this wasn\'t sent from the app. Send to replay it.">captured</span>' : ''}<span class="hint" title="${esc(timingTitle(res.timing))}">${res.time} ms</span>${slot == null && S.req ? sparklineHtml(S.req.id, findReq(S.req.id)?.p.activeEnv, res.slow) : ''}${slowBadgeHtml(res.slow)}<span class="hint">${fmtSize(res.size ?? byteSize(res.body))}</span>
      ${slot == null && flaggedDuring(res).length ? `<button class="link-btn assert-fail" data-action="restab" data-tab="logs" title="Log lines flagged by log watch while this request ran">⚠ ${flaggedDuring(res).length} flagged log line${flaggedDuring(res).length === 1 ? '' : 's'}</button>` : ''}
      ${slot == null && res.snapshotResult ? `<button class="link-btn ${res.snapshotResult.matches ? 'assert-pass' : 'assert-fail'}" data-action="restab" data-tab="snapshot" title="Compared with the saved snapshot">${res.snapshotResult.matches ? '✓ snapshot' : `✗ snapshot (${res.snapshotResult.diffs.length})`}</button>` : ''}
      <button class="btn-ghost small" data-action="copy-body"${slotAttr}>Copy</button>
      ${slot == null ? '<button class="btn-ghost small btn-menu" data-action="report-menu" title="Bug report: request, response, checks, timing, server logs and cURL, as Markdown or HTML">Report</button>' : ''}
      ${DB.settings.ai ? `<button class="btn-ghost small" data-action="trace"${slotAttr} title="Ask Claude, with the spec check, timing, server logs, recent commits and the last good run">${res.status >= 400 ? 'Why did this fail?' : 'Ask Claude'}</button>` : ''}</div>
    ${(res.warnings || []).map((w) => `<div class="warn-text">⚠ ${esc(w)}</div>`).join('')}
    ${validationHtml(res.validation)}
    ${(res.scriptTests || []).map((t) => `<div class="${t.ok ? 'assert-pass' : 'assert-fail'}">${t.ok ? '✓' : '✗'} ${esc(t.name)}${t.error ? ` — ${esc(t.error)}` : ''}</div>`).join('')}
    ${res.scriptLogs?.length ? `<details class="script-log"><summary class="hint">Script log (${res.scriptLogs.length})</summary><pre class="resp-body">${esc(res.scriptLogs.join('\n'))}</pre></details>` : ''}
    ${(res.extracted || []).map((x) => `<div class="hint">↳ ${esc(x.path)} → ${x.to.toLowerCase() === 'bearer' ? 'project bearer token' : `{{${esc(x.to)}}}`}</div>`).join('')}
    ${(res.assertionResults || []).map((a) =>
      `<div class="${a.ok ? 'assert-pass' : 'assert-fail'}">${a.ok ? '✓' : '✗'} ${esc(a.expr)} ${a.err ? esc(a.err) : ''}</div>`).join('')}
    <div class="tabs">${tabs.map(([id, label]) => `<button class="tab${tab === id ? ' active' : ''}" data-action="restab" data-tab="${id}">${label}</button>`).join('')}</div>
    ${panes[tab](res, slot)}`;
}

export function renderResponsePanel() {
  const el = $('response-panel');
  const t = activeTab();
  if (S.req && ['ws', 'sse'].includes(kindOf(S.req))) { el.innerHTML = streamPanelHtml(S.req, t); return; }
  if (t?.sending && !t.response) { el.innerHTML = '<span class="hint">Sending…</span>'; return; }
  el.innerHTML = responseHtml(t?.response, S.req?.assertions, null, t?.resTab);
}
