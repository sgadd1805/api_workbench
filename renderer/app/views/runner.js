// Collection runner page (S.page === 'runner').
import { esc } from '../../shared/html.js';
import { slowBadgeHtml } from './trend.js';
import { DB, S, currentProject, openFeatures, methodLabel } from '../store.js';
import { summarize } from '../runner.js';
import { icon } from '../../shared/icons.js';

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
  const rows = R.results.map((r) => `<tr class="${r.passed ? 'run-pass' : 'run-fail'}">
      <td>${r.passed ? '✓' : '✗'}</td><td>${R.rows?.length || R.iterations > 1 ? r.iteration : ''}</td>
      <td><span class="method-tag m-${esc(methodLabel(r))}">${esc(methodLabel(r))}</span> <span data-action="open-req" data-id="${esc(r.reqId)}" class="link-btn">${esc(r.name)}</span></td>
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
      <div class="spec-row">${R.running ? '<button class="btn-primary danger small" data-action="run-stop">' + icon('stop') + ' Stop</button>' : `<button class="btn-primary small" data-action="run-start" ${scopes.length ? '' : 'disabled'}>${icon('play')} Run</button>`}
        ${R.results.length ? `<span class="run-summary"><span class="assert-pass">${s.passed} passed</span> · <span class="${s.failed ? 'assert-fail' : 'hint'}">${s.failed} failed</span> · ${s.total} requests · ${(s.time / 1000).toFixed(2)} s</span>
          <button class="btn-ghost small" data-action="run-export" data-format="json">Export JSON</button><button class="btn-ghost small" data-action="run-export" data-format="junit">Export JUnit XML</button>` : ''}
        ${R.running ? `<span class="hint">Running… ${R.results.length} done</span>` : ''}</div></div>
    ${rows ? `<table class="run-table"><tr><th></th><th>#</th><th>Request</th><th>Status</th><th>Time</th><th>Problems</th></tr>${rows}</table>` : '<p class="hint">Pick what to run, then ' + icon('play') + ' Run. Requests pass when their assertions and script tests pass (or, with none, when the status is below 400), and their spec check has no errors.</p>'}`;
}
