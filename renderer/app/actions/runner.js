// Collection runner page.
import { notify } from '../../shared/notify.js';
import { S, currentProject, activeEnv, saveDB } from '../store.js';
import { send } from '../http.js';
import { recordHistory } from '../history.js';
import { activeVars } from '../vars.js';
import { parseCsv, requestsInScope, runCollection, toJUnit, scopeLabel, varsUsed, scopeOf } from '../runner.js';
import { renderPage } from '../views/index.js';
import { setPage, attachValidation } from './core.js';

const R = () => S.runner;

export const runnerActions = {
  'open-runner'(d) {
    if (d?.scope) R().scopeKey = d.scope;
    else if (!R().scopeKey) { const p = currentProject(); if (p) R().scopeKey = `project|${p.id}`; }
    setPage('runner');
  },
  async 'run-data'() {
    const file = await window.electronAPI.openTextFile();
    if (!file.ok) { if (!file.canceled) notify(file.error, 'error'); return; }
    const rows = parseCsv(file.content);
    if (!rows.length) return notify('No data rows in that file (the first row must be column names)', 'error');
    Object.assign(R(), { rows, dataName: file.filePath.split(/[\\/]/).pop() }); renderPage();
  },
  'run-data-clear'() { Object.assign(R(), { rows: null, dataName: '' }); renderPage(); },
  async 'run-start'() {
    const r = R();
    const scope = scopeOf(r.scopeKey || document.getElementById('run-scope')?.value);
    const locs = requestsInScope(scope);
    if (!locs.length) return notify('Nothing to run there', 'error');
    const env = r.envId ? locs[0].p.envs.find((e) => e.id === r.envId) : null;
    Object.assign(r, { running: true, stop: false, results: [], label: scopeLabel(scope), overrides: {}, paused: null, pauseNext: false, at: null });
    renderPage();
    await runCollection(locs, async (loc, vars) => {
      const res = await attachValidation(loc, await send(loc, undefined, { vars, env: env || undefined }));
      recordHistory(loc, res, { envId: env?.id ?? loc.p.activeEnv });
      return res;
    }, { iterations: r.iterations, rows: r.rows || [], delayMs: r.delayMs, stopOnFailure: r.stopOnFailure, shouldStop: () => r.stop,
      beforeSend: (loc, vars, pos) => beforeStep(loc, vars, pos, env) },
    (result) => { r.results.push(result); if (S.page === 'runner') renderPage(); });
    Object.assign(r, { running: false, paused: null, at: null }); resume = null; renderPage();
    const failed = r.results.filter((x) => !x.passed).length;
    notify(failed ? `Run finished: ${failed} of ${r.results.length} failed` : `Run finished: all ${r.results.length} passed`, failed ? 'error' : 'info', 6000);
  },
  'run-stop'() { R().stop = true; if (resume) finishPause('stop'); },
  // Breakpoints: pause before a request; Pause stops before the next one; Step pauses before every one.
  'run-bp'(d) { const b = R().breakpoints; if (b.has(d.id)) b.delete(d.id); else b.add(d.id); renderPage(); },
  'run-bp-clear'() { R().breakpoints.clear(); renderPage(); },
  'run-pause'() { R().pauseNext = true; renderPage(); },
  'run-continue'() { R().stepMode = false; finishPause('send'); },
  'run-step'() { R().stepMode = true; finishPause('send'); },
  'run-skip'() { finishPause('skip'); },
  'run-step-mode'() { R().stepMode = !R().stepMode; renderPage(); },
  async 'run-export'(d) {
    const r = R();
    const name = (r.label || 'run').replace(/[^\w.-]+/g, '_');
    const content = d.format === 'junit' ? toJUnit(r.label || 'run', r.results) : JSON.stringify({ name: r.label, at: new Date().toISOString(), results: r.results }, null, 2);
    const res = await window.electronAPI.saveTextFile(`${name}-results.${d.format === 'junit' ? 'xml' : 'json'}`, content);
    if (res.ok) notify('Saved ' + res.filePath); else if (!res.canceled) notify(res.error, 'error');
  },
};

// ---- Pausing at breakpoints: the paused step's request and the run's variables can be edited before it's sent.
let resume = null; // resolves the paused step's beforeSend

// runCollection's beforeSend: pauses at a breakpoint (or when stepping / asked to pause), else sends with the run's
// variable overrides.
function beforeStep(loc, vars, pos, envOverride) {
  const r = R();
  r.at = { reqId: loc.r.id, index: pos.index };
  const withOverrides = Object.keys(r.overrides).length ? { ...vars, ...r.overrides } : vars;
  if (!(r.stepMode || r.pauseNext || r.breakpoints.has(loc.r.id))) return { action: 'send', vars: withOverrides };
  r.pauseNext = false;
  const env = envOverride || activeEnv(loc.p);
  const current = { ...activeVars(env ? { envs: [env], activeEnv: env.id } : null), ...withOverrides };
  const names = [...new Set([...varsUsed(loc.r), ...Object.keys(vars), ...Object.keys(r.overrides)])];
  r.paused = {
    loc, vars, pos, current, save: false,
    draft: { method: loc.r.method, url: loc.r.url, headers: structuredClone(loc.r.headers), text: loc.r.body.text, bodyType: loc.r.body.type },
    varRows: names.map((k) => ({ k, v: current[k] ?? '', on: true })),
  };
  if (S.page === 'runner') renderPage();
  else notify(`Run paused before "${loc.r.name}" (Collection runner)`, 'info', 6000);
  return new Promise((done) => { resume = done; });
}

// Ends the pause: 'send' (with the edits), 'skip' or 'stop'.
function finishPause(action) {
  const r = R(), p = r.paused, done = resume;
  if (!p || !done) return;
  resume = null; r.paused = null;
  if (action !== 'send') { done({ action }); renderPage(); return; }
  // Variables: a changed or added value applies to this and every later step of the run.
  for (const row of p.varRows) if (row.k && row.on !== false && String(row.v) !== String(p.current[row.k] ?? '')) r.overrides[row.k] = row.v;
  const d = p.draft, orig = p.loc.r;
  const edited = d.method !== orig.method || d.url !== orig.url || d.text !== orig.body.text || JSON.stringify(d.headers) !== JSON.stringify(orig.headers);
  let loc = p.loc;
  if (edited && p.save) { Object.assign(orig, { method: d.method, url: d.url, headers: d.headers }); orig.body.text = d.text; saveDB(); }
  else if (edited) loc = { ...p.loc, r: { ...structuredClone(orig), method: d.method, url: d.url, headers: d.headers, body: { ...structuredClone(orig.body), text: d.text } } };
  done({ action: 'send', loc, vars: { ...p.vars, ...r.overrides } });
  renderPage();
}

// Paused-step fields. → true when handled
function onPausedInput(el) {
  const p = R().paused; if (!p) return false;
  if (el.id === 'rp-method') { p.draft.method = el.value; return true; }
  if (el.id === 'rp-url') { p.draft.url = el.value; return true; }
  if (el.id === 'rp-body') { p.draft.text = el.value; return true; }
  if (el.id === 'rp-save') { p.save = el.checked; return true; }
  return false;
}

export function onRunnerInput(el) {
  const r = R();
  if (onPausedInput(el)) return true;
  if (el.id === 'run-iterations') { r.iterations = Math.max(1, parseInt(el.value, 10) || 1); return true; }
  if (el.id === 'run-delay') { r.delayMs = Math.max(0, parseInt(el.value, 10) || 0); return true; }
  return false;
}
export function onRunnerChange(el) {
  const r = R();
  if (onPausedInput(el)) return true;
  if (el.id === 'run-scope') { r.scopeKey = el.value; return true; }
  if (el.id === 'run-env') { r.envId = el.value || null; return true; }
  if (el.id === 'run-stop') { r.stopOnFailure = el.checked; return true; }
  return false;
}
