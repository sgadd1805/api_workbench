// Collection runner page (S.page === 'runner').
import { esc } from '../../shared/html.js';
import { slowBadgeHtml } from './trend.js';
import { DB, S, currentProject, openFeatures, methodLabel } from '../store.js';
import { summarize, requestsInScope, scopeOf } from '../runner.js';
import { kvRows } from './kv.js';
import { icon } from '../../shared/icons.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// The requests of the chosen scope, in run order, each with a breakpoint toggle; the current step is marked.
function stepsHtml(R) {
  const locs = requestsInScope(scopeOf(R.scopeKey));
  if (!locs.length) return '';
  const items = locs.map((l, i) => {
    const bp = R.breakpoints.has(l.r.id), here = R.running && R.at?.index === i;
    return `<li class="run-step${here ? ' here' : ''}${R.paused?.pos.index === i ? ' paused' : ''}">
      <button class="bp-dot${bp ? ' on' : ''}" data-action="run-bp" data-id="${esc(l.r.id)}" title="${bp ? 'Remove breakpoint' : 'Pause before this request'}" aria-pressed="${bp}" aria-label="Breakpoint before ${esc(l.r.name)}"></button>
      <span class="hint">${i + 1}.</span> <span class="method-tag m-${esc(methodLabel(l.r))}">${esc(methodLabel(l.r))}</span> ${esc(l.r.name)}${here && !R.paused ? ' <span class="hint">sending…</span>' : ''}</li>`;
  }).join('');
  return `<details class="run-steps-box" ${R.breakpoints.size || R.paused || R.stepMode ? 'open' : ''}><summary class="hint">Steps (${locs.length})${R.breakpoints.size ? ` · ${R.breakpoints.size} breakpoint${R.breakpoints.size === 1 ? '' : 's'}` : ''} — click a dot to pause before that request</summary>
    <ol class="run-steps">${items}</ol>
    <div class="spec-row"><label><input type="checkbox" data-action="run-step-mode" ${R.stepMode ? 'checked' : ''}/> Step through: pause before every request</label>
      ${R.breakpoints.size ? '<button class="btn-ghost small" data-action="run-bp-clear">Clear breakpoints</button>' : ''}</div></details>`;
}

// A paused step: its request (edits apply to this send, or are saved) and the run's variables.
function pausedHtml(R) {
  const p = R.paused; if (!p) return '';
  const d = p.draft, textBody = ['raw', 'json'].includes(d.bodyType) && !['GET', 'HEAD'].includes(d.method);
  return `<section class="run-paused">
    <h4 class="section-title">⏸ Paused before ${p.pos.index + 1}. ${esc(p.loc.r.name)}${p.pos.iteration > 1 || R.rows?.length ? ` (iteration ${p.pos.iteration})` : ''}</h4>
    <div class="spec-row"><button class="btn-primary small" data-action="run-continue" title="Send it and run on to the next breakpoint">${icon('play')} Continue</button>
      <button class="btn-ghost small" data-action="run-step" title="Send it, then pause before the next request">Step</button>
      <button class="btn-ghost small" data-action="run-skip" title="Don't send this request; go on with the next">Skip</button>
      <button class="btn-ghost small danger" data-action="run-stop">${icon('stop')} Stop</button></div>
    <h4 class="mt-10 section-title">Variables</h4>
    <p class="hint mb-6">Values for this run: a change applies to this request and every later one (the environment is left as it is).</p>
    ${kvRows(p.varRows, 'rp-vars', { toggle: false, keyPh: 'variable', valPh: 'value' })}
    <h4 class="mt-10 section-title">Request</h4>
    <div class="url-bar"><select id="rp-method" class="method-select">${METHODS.map((m) => `<option ${m === d.method ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <input type="text" id="rp-url" class="grow" value="${esc(d.url)}" spellcheck="false"/></div>
    <div class="hint mt-6">Headers</div>
    <div>${kvRows(d.headers, 'rp-headers', { keyPh: 'Header', valPh: 'value (may use {{variables}})' })}</div>
    ${textBody ? `<label class="hint mt-6 block" for="rp-body">Body</label><textarea id="rp-body" rows="6" spellcheck="false">${esc(d.text)}</textarea>` : d.bodyType !== 'none' ? `<p class="hint">The ${esc(d.bodyType)} body is sent as saved.</p>` : ''}
    <label class="mt-6 block"><input type="checkbox" id="rp-save" ${p.save ? 'checked' : ''}/> Save these request changes to "${esc(p.loc.r.name)}" <span class="hint">(otherwise they're for this send only)</span></label>
  </section>`;
}

// A replayed captured request that came back different (not a failure: assertions decide that).
function capturedNote(d) {
  if (!d || d.same) return '';
  const what = [d.status && `status ${d.status[0]} → ${d.status[1]}`, d.fields?.length && `${d.fields.length} field${d.fields.length === 1 ? '' : 's'}`, !d.fields && d.textChanged && 'body'].filter(Boolean).join(', ');
  return ` <span class="captured-note" title="Differs from the response captured in the login window (open the request: vs captured tab)">≠ captured: ${esc(what)}</span>`;
}

export function runnerPageHtml() {
  const p = currentProject();
  const R = S.runner;
  const scopes = [
    ...(p ? [{ value: `project|${p.id}`, label: `Project: ${p.name} (all requests)` }, ...p.folders.map((f) => ({ value: `folder|${f.id}`, label: `Folder: ${f.name} (${f.requests.length})` }))] : []),
    ...openFeatures().map((f) => ({ value: `feature|${f.id}`, label: `Feature: ${f.name} (${f.requestIds.length})` })),
  ];
  const s = summarize(R.results);
  const rows = R.results.map((r) => `<tr class="${r.skipped ? '' : r.passed ? 'run-pass' : 'run-fail'}">
      <td>${r.skipped ? '<span class="hint" title="Skipped at a breakpoint">–</span>' : r.passed ? '✓' : '✗'}</td><td>${R.rows?.length || R.iterations > 1 ? r.iteration : ''}</td>
      <td><span class="method-tag m-${esc(methodLabel(r))}">${esc(methodLabel(r))}</span> <span data-action="open-req" data-id="${esc(r.reqId)}" class="link-btn">${esc(r.name)}</span>${r.edited ? ' <span class="hint" title="Edited at a breakpoint before sending">(edited)</span>' : ''}${r.skipped ? ' <span class="hint">skipped</span>' : ''}</td>
      <td>${r.status ?? '—'}</td><td>${r.time} ms ${slowBadgeHtml(r.slow, { short: true })}</td><td class="hint">${esc(r.failures.join(' · '))}${capturedNote(r.capturedDiff)}</td></tr>`).join('');
  return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button><h3>Collection runner</h3></div>
    <div class="runner-form">
      <div class="spec-row"><label class="hint net-label" for="run-scope">Run</label>
        <select id="run-scope" class="grow">${scopes.map((o) => `<option value="${esc(o.value)}" ${o.value === R.scopeKey ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
      <div class="spec-row"><label class="hint net-label" for="run-env">Environment</label>
        <select id="run-env"><option value="">${p?.activeEnv ? 'Active environment' : 'None'}</option>${(p?.envs || []).map((e) => `<option value="${esc(e.id)}" ${e.id === R.envId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
        <label class="ml-12 hint" for="run-iterations">Iterations</label><input type="text" id="run-iterations" value="${R.iterations}" class="w-50"/>
        <label class="ml-12 hint" for="run-delay">Delay</label><input type="text" id="run-delay" value="${R.delayMs}" class="w-60"/><span class="hint">ms</span>
        <label class="ml-12"><input type="checkbox" id="run-stop" ${R.stopOnFailure ? 'checked' : ''}/> Stop on first failure</label></div>
      <div class="spec-row"><span class="hint net-label">Data</span>
        ${R.rows ? `<span>${R.rows.length} rows from <b>${esc(R.dataName)}</b> (columns: ${esc(Object.keys(R.rows[0] || {}).join(', '))}) — one iteration per row, columns as {{variables}}</span> <button class="btn-ghost small" data-action="run-data-clear">Remove</button>`
          : '<button class="btn-ghost small" data-action="run-data">Load CSV…</button><span class="hint">optional: one iteration per row, columns become {{variables}}</span>'}</div>
      ${stepsHtml(R)}
      <div class="spec-row">${R.running ? `<button class="btn-primary danger small" data-action="run-stop">${icon('stop')} Stop</button>${R.paused ? '' : `<button class="btn-ghost small" data-action="run-pause" ${R.pauseNext ? 'disabled' : ''} title="Pause before the next request">${R.pauseNext ? 'Pausing…' : '⏸ Pause'}</button>`}` : `<button class="btn-primary small" data-action="run-start" ${scopes.length ? '' : 'disabled'}>${icon('play')} Run</button>`}
        ${R.results.length ? `<span class="run-summary"><span class="assert-pass">${s.passed} passed</span> · <span class="${s.failed ? 'assert-fail' : 'hint'}">${s.failed} failed</span>${s.skipped ? ` · ${s.skipped} skipped` : ''} · ${s.total} request${s.total === 1 ? "" : "s"} · ${(s.time / 1000).toFixed(2)} s</span>
          <button class="btn-ghost small" data-action="run-export" data-format="json">Export JSON</button><button class="btn-ghost small" data-action="run-export" data-format="junit">Export JUnit XML</button>` : ''}
        ${R.running ? `<span class="hint">${R.paused ? 'Paused' : 'Running…'} · ${R.results.length} done</span>` : ''}</div></div>
    ${pausedHtml(R)}
    ${rows ? `<table class="run-table"><tr><th></th><th>#</th><th>Request</th><th>Status</th><th>Time</th><th>Problems</th></tr>${rows}</table>` : '<p class="hint">Pick what to run, then ' + icon('play') + ' Run. Requests pass when their assertions and script tests pass (or, with none, when the status is below 400), and their spec check has no errors.</p>'}`;
}
