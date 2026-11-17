// Fuzz page (S.page === 'fuzz'; actions/fuzz.js): options, progress, and per-request results with each case's
// verdict, what was sent and what came back.
import { esc } from '../../shared/html.js';
import { prettyJson } from '../../shared/json.js';
import { S, currentProject, findReq, allRequests, project } from '../store.js';
import { VERDICTS, fuzzSummary } from '../openapi/fuzz.js';
import { icon } from '../../shared/icons.js';

// Scope choices for the page: the open request, then like the runner.
function fuzzScopes() {
  const p = currentProject();
  const req = S.req && findReq(S.req.id);
  const out = [];
  if (req) out.push({ value: `request|${req.r.id}`, label: `Request: ${req.r.name}` });
  if (p) {
    out.push({ value: `project|${p.id}`, label: `Project: ${p.name} (${allRequests(p).length})` });
    for (const fd of p.folders) out.push({ value: `folder|${fd.id}`, label: `Folder: ${fd.name} (${fd.requests.length})` });
  }
  const chosen = S.fuzz.scopeKey;
  if (chosen?.startsWith('request|') && !out.some((o) => o.value === chosen)) {
    const loc = findReq(chosen.slice(8)); if (loc) out.unshift({ value: chosen, label: `Request: ${loc.r.name}${loc.p !== p ? ` (${project(loc.p.id).name})` : ''}` });
  }
  return out;
}

const VERDICT_CLASS = { pass: 'assert-pass', fail: 'assert-fail', warn: 'warn-text' };
const EXPECT = { reject: 'should be rejected (4xx)', auth: 'should need credentials (401 / 403)', any: 'anything but a server error' };
const headerLines = (h) => Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
const clip = (s, n = 3000) => (s && s.length > n ? s.slice(0, n) + `… (${s.length - n} more)` : s || '');

function sentText(w) {
  const body = w.bodyParts ? w.bodyParts.map((p) => (p.file != null ? `${p.name}: @${p.file}` : `${p.name}: ${p.value ?? ''}`)).join('\n') : w.bodyFile ? `@${w.bodyFile}` : w.body ? prettyJson(w.body) : '';
  return `${w.method} ${w.url}\n${headerLines(w.headers)}${body ? '\n\n' + clip(body) : ''}`;
}

function caseRow(c, selected) {
  const v = VERDICTS[c.verdict] || { label: c.verdict, level: 'warn' };
  const icn = v.level === 'pass' ? '✓' : v.level === 'fail' ? '✗' : '⚠';
  const row = `<tr class="fuzz-case${selected ? ' open' : ''}" data-action="fuzz-case" data-id="${esc(c.id)}">
    <td class="${VERDICT_CLASS[v.level]}">${icn}</td><td><code>${esc(c.where)}</code></td><td>${esc(c.label)}</td>
    <td>${c.status ?? '—'}</td><td>${c.time != null ? `${c.time} ms` : ''}</td>
    <td class="${VERDICT_CLASS[v.level]}">${v.level === 'pass' ? '' : esc(v.label)}${c.issues?.length ? `<div class="hint">${esc(c.issues.slice(0, 2).map((i) => `${i.where} ${i.message}`).join(' · '))}</div>` : ''}</td></tr>`;
  if (!selected) return row;
  const res = c.response;
  return row + `<tr class="fuzz-detail"><td></td><td colspan="5">
    <div class="hint mb-6">Expected: ${esc(EXPECT[c.expect] || c.expect)}${c.error ? ` · ${esc(c.error)}` : ''}</div>
    <div class="spec-row mb-6"><button class="btn-ghost small" data-action="fuzz-save" data-id="${esc(c.id)}">Save as request…</button>
      <button class="btn-ghost small" data-action="fuzz-curl" data-id="${esc(c.id)}">Copy as cURL</button></div>
    <h4 class="section-title">Sent</h4><pre class="resp-body fuzz-pre">${esc(sentText(c.wire))}</pre>
    ${res ? `<h4 class="section-title">Response ${res.status}</h4><pre class="resp-body fuzz-pre">${esc(`${headerLines(res.headers)}\n\n${res.body ? prettyJson(res.body) : ''}`)}</pre>` : ''}</td></tr>`;
}

function groupHtml(g, f) {
  const shown = f.onlyProblems ? g.cases.filter((c) => c.verdict !== 'ok') : g.cases;
  const s = fuzzSummary(g.cases);
  const open = f.open[g.reqId];
  const base = g.baseline.error ? `<span class="assert-fail">baseline failed: ${esc(g.baseline.error)}</span>`
    : `baseline <span class="${g.baseline.status < 400 ? 'status-ok' : 'status-err'}">${g.baseline.status}</span>`;
  return `<section class="fuzz-group">
    <h4 class="fuzz-head" data-action="fuzz-toggle" data-id="${esc(g.reqId)}">${open ? '▾' : '▸'} <span class="method-tag m-${esc(g.method)}">${esc(g.method)}</span> ${esc(g.name)}
      <span class="hint">→ <code>${esc(g.op)}</code> · ${base} · ${g.cases.length} case${g.cases.length === 1 ? '' : 's'}</span>
      ${s.fail ? `<span class="assert-fail">${s.fail} problem${s.fail === 1 ? '' : 's'}</span>` : ''}${s.warn ? ` <span class="warn-text">${s.warn} off-spec</span>` : ''}
      <button class="link-btn" data-action="open-req" data-id="${esc(g.reqId)}">open request</button></h4>
    ${g.baseline.status >= 400 ? `<p class="warn-text">⚠ The request as saved got ${g.baseline.status}, so "should be rejected" cases tell you little: fix the request (or its environment) first.</p>` : ''}
    ${open ? (shown.length ? `<table class="run-table fuzz-table"><tr><th></th><th>Where</th><th>Case</th><th>Status</th><th>Time</th><th>Problem</th></tr>
      ${shown.map((c) => caseRow(c, f.selected === c.id)).join('')}</table>` : `<p class="hint">${g.cases.length ? 'No problems.' : 'No cases: the operation has no parameters or JSON body to vary.'}</p>`) : ''}</section>`;
}

export function fuzzPageHtml() {
  const f = S.fuzz, p = currentProject();
  const scopes = fuzzScopes();
  const all = f.results.flatMap((g) => g.cases);
  const s = fuzzSummary(all);
  const by = s.byVerdict;
  const summary = all.length ? `<span class="run-summary">${all.length} cases ·
      <span class="${by['server-error'] ? 'assert-fail' : 'hint'}">${by['server-error'] || 0} server errors</span> ·
      <span class="${by.accepted ? 'assert-fail' : 'hint'}">${by.accepted || 0} accepted invalid input</span> ·
      <span class="${by['auth-open'] ? 'assert-fail' : 'hint'}">${by['auth-open'] || 0} worked without credentials</span> ·
      <span class="${by['no-response'] ? 'assert-fail' : 'hint'}">${by['no-response'] || 0} no response</span> ·
      <span class="${s.warn ? 'warn-text' : 'hint'}">${s.warn} off-spec</span></span>` : '';
  return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button><h3>Fuzz from spec</h3></div>
    <p class="hint mb-8">Sends each request once as saved, then once per case: one parameter, header or body field made invalid or unusual
      (missing, wrong type, just past a limit, oversized, odd characters, malformed JSON, no credentials), using the request's spec operation.
      It flags server errors (5xx), invalid input that was accepted, operations that work without credentials, and responses that don't match the spec.
      Nothing is saved: these sends skip History, cookies, extract rules and variables.</p>
    <p class="warn-text mb-8">⚠ Use a test environment: this sends invalid and unusual data, and POST / PUT / PATCH cases may create or change records.</p>
    <div class="runner-form">
      <div class="spec-row"><label class="hint net-label" for="fuzz-scope">Fuzz</label>
        <select id="fuzz-scope" class="grow">${scopes.map((o) => `<option value="${esc(o.value)}" ${o.value === f.scopeKey ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
      <div class="spec-row"><label class="hint net-label" for="fuzz-env">Environment</label>
        <select id="fuzz-env"><option value="">${p?.activeEnv ? 'Active environment' : 'None'}</option>${(p?.envs || []).map((e) => `<option value="${esc(e.id)}" ${e.id === f.envId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
        <label class="ml-12 hint" for="fuzz-max">Cases per request</label><input type="text" id="fuzz-max" value="${f.maxPerOp}" class="w-50"/>
        <label class="ml-12 hint" for="fuzz-delay">Delay</label><input type="text" id="fuzz-delay" value="${f.delayMs}" class="w-60"/><span class="hint">ms</span></div>
      <div class="spec-row"><span class="net-label"></span>
        <label><input type="checkbox" id="fuzz-oversized" ${f.oversized ? 'checked' : ''}/> Oversized strings (64 KB)</label>
        <label class="ml-12"><input type="checkbox" id="fuzz-delete" ${f.includeDelete ? 'checked' : ''}/> Include DELETE requests</label></div>
      <div class="spec-row">${f.running ? `<button class="btn-primary danger small" data-action="fuzz-stop">${icon('stop')} Stop</button><span class="hint">${f.progress.done} of ${f.progress.total} cases…</span>`
        : `<button class="btn-primary small" data-action="fuzz-start" ${scopes.length ? '' : 'disabled'}>${icon('play')} Run</button>`}
        ${summary}
        ${all.length ? `<label class="ml-12"><input type="checkbox" data-action="fuzz-only-problems" ${f.onlyProblems ? 'checked' : ''}/> Only problems</label>` : ''}</div></div>
    ${f.skipped.length ? `<details class="mb-8"><summary class="hint">${f.skipped.length} request${f.skipped.length === 1 ? '' : 's'} skipped</summary>${f.skipped.map((x) => `<div class="hint">${esc(x)}</div>`).join('')}</details>` : ''}
    ${f.results.map((g) => groupHtml(g, f)).join('') || (f.running ? '' : '<p class="hint">Pick what to fuzz, then Run. Requests need an attached spec (Project → API specs) whose operation they match.</p>')}`;
}
