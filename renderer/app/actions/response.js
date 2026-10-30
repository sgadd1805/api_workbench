// Response panes (active tab, compare columns, history entry page).
import { copyText, flashDone } from '../../shared/html.js';
import { S, DB, activeTab, saveDB } from '../store.js';
import { compare as compareSnapshot, makeSnapshot } from '../snapshot.js';
import { buildReport, toMarkdown, toHtml } from '../report.js';
import { openMenu } from '../views/menu.js';
import { loadTrace, traceSpans } from './otel.js';
import { historyEntry } from '../history.js';
import { renderResponsePanel, renderCompare, renderPage, historyResponse } from '../views/index.js';
import { findReq } from '../store.js';
import { logIdsFor, sourceDef, SEARCHABLE } from '../tasks.js';
import { uid } from '../store.js';
import { runsFor } from '../history.js';
import { clearTimings } from '../timings.js';
import { gitState } from '../git.js';
import { cachedTokenValues } from '../tokens.js';
import { notify } from '../../shared/notify.js';
import { refreshViewers, stepMatch, bodyFileName } from '../views/viewer.js';

// data-slot says whose response a button belongs to: a compare column (0/1), the history entry page
// ('history'), or (no slot) the active tab.
export function responseFor(d) {
  if (d.slot === 'proxy') { const x = S.proxy.exchanges.find((e) => e.id === S.proxy.selected); return x && !x.error ? { status: x.status, statusText: x.statusText, headers: x.responseHeaders, ...x.response, time: x.time } : null; }
  if (d.slot === 'history') { const e = historyEntry(S.history.id); return e && historyResponse(e); }
  if (d.slot != null) return (S.compare.mode === 'envs' ? S.compare.ab.results : S.compare.results)[+d.slot];
  return activeTab()?.response;
}

// Response panes on screen: the compare page, the history entry page, or the active tab's.
function rerenderResponses() {
  if (S.page === 'compare') renderCompare(); else if (S.page === 'history' || S.page === 'proxy') renderPage(); else renderResponsePanel();
  stepMatch(0);
}

// Typing in a viewer's filter or search box.
export function onViewerInput(el) {
  if (el.classList.contains('view-filter')) S.respView.filter = el.value;
  else if (el.classList.contains('view-search')) S.respView.search = el.value;
  else return false;
  // The same options apply to every pane: keep the other panes' boxes in step.
  for (const other of document.querySelectorAll(`.${el.classList[0]}`)) if (other !== el) other.value = el.value;
  refreshViewers(responseFor);
  return true;
}

const nameFor = (d) => (d.slot == null ? S.req?.name : d.slot === 'history' ? historyEntry(S.history.id)?.reqName : d.slot === 'proxy' ? 'captured' : 'response');

// After the snapshot or its ignore rules change: compare the open response again.
function recompareSnapshot() {
  const res = activeTab()?.response;
  if (res && !res.error) res.snapshotResult = S.req?.snapshot ? compareSnapshot(S.req.snapshot, res) : undefined;
}

export function onSnapshotInput(el) {
  if (el.id !== 'snap-ignore' || !S.req?.snapshot) return false;
  S.req.snapshot.ignore = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
  saveDB(); recompareSnapshot();
  // Update the result without re-rendering the textarea being typed in.
  clearTimeout(onSnapshotInput.t); onSnapshotInput.t = setTimeout(() => { const at = el.selectionStart; renderResponsePanel(); const again = document.getElementById('snap-ignore'); again?.focus(); again?.setSelectionRange(at, at); }, 400);
  return true;
}

// The report for the open response: correlated log lines are looked up first if not loaded yet.
async function reportFor(res) {
  const loc = S.req && findReq(S.req.id); if (!loc || !res) return null;
  let logs = res.logMatches?.groups;
  if (!logs && res.correlation) { const ids = logIdsFor(loc.p); logs = ids.length ? await window.electronAPI.logsFind(ids, [res.correlation.requestId, res.correlation.traceId]) : []; }
  const env = loc.p.envs.find((e) => e.id === loc.p.activeEnv);
  const extra = (res.serverLogs?.results || []).filter((r) => r.hits?.length).map((r) => ({ name: `${r.name} (server search)`, lines: r.hits.flatMap((h) => [...h.before, h, ...h.after].map((l) => ({ text: `${h.file}:${l.line ?? ''} ${l.text}` }))) }));
  let spans = [];
  if (res.correlation) spans = traceSpans.get(res.correlation.traceId) || await window.electronAPI.otelTrace(res.correlation.traceId);
  return buildReport({ loc, res, envName: env?.name, logs: [...(logs || []), ...extra], spans });
}

export const responseActions = {
  'report-menu'(_d, el) {
    const res = activeTab()?.response; if (!res) return;
    const name = (S.req?.name || 'report').replace(/[^\w.-]+/g, '_');
    openMenu([
      { head: 'Bug report (credentials redacted)' },
      { label: 'Copy as Markdown', hint: 'for a ticket', run: async () => { copyText(toMarkdown(await reportFor(res))); notify('Report copied as Markdown'); } },
      { label: 'Save as Markdown…', run: async () => { const out = await window.electronAPI.saveTextFile(`${name}-report.md`, toMarkdown(await reportFor(res))); if (out.ok) notify('Saved ' + out.filePath); } },
      { label: 'Save as HTML page…', run: async () => { const out = await window.electronAPI.saveTextFile(`${name}-report.html`, toHtml(await reportFor(res))); if (out.ok) notify('Saved ' + out.filePath); } },
    ], el);
  },
  'snap-save'() {
    const res = activeTab()?.response; if (!res || res.error || !S.req) return;
    S.req.snapshot = makeSnapshot(res, S.req.snapshot?.ignore || []);
    saveDB(); recompareSnapshot(); renderResponsePanel();
    notify('Saved as the snapshot: later responses are compared with it');
  },
  'snap-remove'() { if (!S.req) return; delete S.req.snapshot; saveDB(); recompareSnapshot(); renderResponsePanel(); },
  'snap-ignore'(d) {
    const snap = S.req?.snapshot; if (!snap) return;
    if (!snap.ignore.includes(d.rule)) snap.ignore.push(d.rule);
    saveDB(); recompareSnapshot(); renderResponsePanel();
  },
  'view-mode'(d) { Object.assign(S.respView, { mode: d.mode, full: false }); rerenderResponses(); },
  'view-wrap'() { S.respView.wrap = !S.respView.wrap; rerenderResponses(); },
  'view-full'() { S.respView.full = true; refreshViewers(responseFor); },
  'view-step'(d) { stepMatch(+d.dir); },
  async 'view-save'(d) {
    const res = responseFor(d); if (!res) return;
    const name = bodyFileName(res, nameFor(d));
    const out = res.binary ? await window.electronAPI.saveBinaryFile(name, res.bodyBase64) : await window.electronAPI.saveTextFile(name, res.body);
    if (out.ok) notify('Saved ' + out.filePath); else if (!out.canceled) notify(out.error, 'error');
  },
  async 'view-open'(d) {
    const res = responseFor(d); if (!res) return;
    const out = await window.electronAPI.openInDefaultApp(bodyFileName(res, nameFor(d)), res.binary ? { base64: res.bodyBase64 } : { content: res.body });
    if (!out.ok) notify(out.error, 'error');
  },
  restab(d) {
    if (S.page === 'compare') { S.compare.resTab = d.tab; renderCompare(); }
    else if (S.page === 'history') { S.history.resTab = d.tab; renderPage(); }
    else { activeTab().resTab = d.tab; renderResponsePanel(); if (d.tab === 'logs') loadLogs(activeTab().response); if (d.tab === 'trace') loadTrace(activeTab().response, { force: true }); }
  },
  'history-base'(d) { activeTab().historyBase = +d.idx; renderResponsePanel(); },
  // History tab → Response time: this environment or all of them; forget the request's times.
  'trend-envs'(d) { const t = activeTab(); if (t) { t.trendAllEnvs = d.all === '1'; renderResponsePanel(); } },
  'trend-reset'(d) { if (!d.id) return; clearTimings(d.id); notify('Response times for this request were reset'); renderResponsePanel(); },
  'copy-body'(d, el) { copyText(responseFor(d)?.body || ''); flashDone(el); },
  'logs-refresh'() { loadLogs(activeTab()?.response, { force: true }); },
  async 'logs-search-servers'() {
    const res = activeTab()?.response, loc = S.req && findReq(S.req.id);
    if (!res?.correlation || !loc) return;
    const sources = loc.p.logSources.filter((x) => SEARCHABLE.has(x.type));
    if (!sources.length) return notify('Add a Server, Kubernetes, Docker or File log source under Project → Tasks & logs first', 'error', 7000);
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query = { pattern: `${esc(res.correlation.requestId)}|${esc(res.correlation.traceId)}`, regex: true, ignoreCase: false, context: 3, since: '1h', max: 200 };
    res.serverLogs = { running: true, query, results: sources.map((x) => ({ name: x.name, running: true, hits: [] })) };
    renderResponsePanel();
    await Promise.all(sources.map(async (src, i) => {
      const out = await window.electronAPI.logsSearch(uid(), sourceDef(loc.p, src), query);
      Object.assign(res.serverLogs.results[i], out.ok ? out : { error: out.error }, { running: false });
      if (activeTab()?.response === res) renderResponsePanel();
    }));
    res.serverLogs.running = false;
    if (activeTab()?.response === res) renderResponsePanel();
  },
  'captured-gap'(d) { const tab = activeTab(); if (!tab) return; tab.capturedOpen = [...(tab.capturedOpen || []), d.gap]; renderResponsePanel(); },
  async trace(d) {
    const res = responseFor(d); if (!res) return;
    notify('Gathering context for Claude…');
    const context = await failureContext(res, d.slot == null ? S.req?.id : null);
    const r = await window.electronAPI.claudeTrace({ requestData: res.requestData, responseData: res, context, secrets: cachedTokenValues() });
    if (!r.ok) alert('Trace failed: ' + (r.error || ''));
  },
};

// Server log lines for a response's correlation ids, cached on the response object.
export async function loadLogs(res, { force = false } = {}) {
  if (!res?.correlation || (res.logMatches && !res.logMatches.loading && !force)) return;
  const loc = S.req && findReq(S.req.id);
  const ids = logIdsFor(loc?.p);
  res.logMatches = { loading: true };
  renderResponsePanel();
  const groups = ids.length ? await window.electronAPI.logsFind(ids, [res.correlation.requestId, res.correlation.traceId]) : [];
  res.logMatches = { loading: false, groups, sources: ids.length };
  if (loc?.p.traceUrl) res.traceLink = loc.p.traceUrl.replace('{traceId}', res.correlation.traceId).replace('{requestId}', res.correlation.requestId);
  if (activeTab()?.response === res) renderResponsePanel();
}

// Everything known about an exchange, for "Why did this fail?" (main/claude.js tracePrompt). Sections
// turned off in Settings → Privacy (DB.settings.aiPrompt) aren't gathered at all.
async function failureContext(res, reqId) {
  const want = DB.settings.aiPrompt || {}, on = (k) => want[k] !== false;
  const loc = reqId && findReq(reqId);
  const ctx = { timing: res.timing || null, validation: res.validation || null, warnings: res.warnings || [] };
  if (loc) {
    const ids = logIdsFor(loc.p);
    if (on('logs') && res.correlation && ids.length) ctx.logs = await window.electronAPI.logsFind(ids, [res.correlation.requestId, res.correlation.traceId]);
    const good = on('lastGood') && runsFor(reqId, 50).find((r) => r.status < 400 && r !== res && r.body !== res.body);
    if (good) ctx.lastGood = { status: good.status, at: new Date(good.at).toISOString(), body: good.body.slice(0, 4000), headers: good.headers };
    const by = (c) => (on('commitAuthors') ? ` ${c.author}` : '');
    const commits = on('commits') && gitState(reqId).result?.commits;
    if (commits?.length) ctx.commits = commits.slice(0, 8).map((c) => `${c.short} ${c.date.slice(0, 10)}${by(c)}: ${c.subject} (${c.reasons.join('; ')})`);
    else if (on('commits') && loc.p.codeFolder) {
      const { defaultTerms } = await import('../git.js');
      const terms = defaultTerms({ op: null, url: res.requestData?.url || loc.r.url });
      const hist = terms.length ? await Promise.race([window.electronAPI.gitRequestHistory({ folder: loc.p.codeFolder, terms }), new Promise((r) => setTimeout(() => r(null), 8000))]) : null;
      if (hist?.ok) ctx.commits = hist.commits.slice(0, 8).map((c) => `${c.short} ${c.date.slice(0, 10)}${by(c)}: ${c.subject}`);
    }
  }
  return ctx;
}
