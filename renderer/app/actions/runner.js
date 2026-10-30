// Collection runner page.
import { notify } from '../../shared/notify.js';
import { S, currentProject } from '../store.js';
import { send } from '../http.js';
import { recordHistory } from '../history.js';
import { parseCsv, requestsInScope, runCollection, toJUnit, scopeLabel } from '../runner.js';
import { renderPage } from '../views/index.js';
import { setPage, attachValidation } from './core.js';

const R = () => S.runner;
const scopeOf = (key) => { const [type, id] = (key || '').split('|'); return { type, id, projectId: type === 'project' ? id : currentProject()?.id }; };

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
    Object.assign(r, { running: true, stop: false, results: [], label: scopeLabel(scope) });
    renderPage();
    await runCollection(locs, async (loc, vars) => {
      const res = await attachValidation(loc, await send(loc, undefined, { vars, env: env || undefined }));
      recordHistory(loc, res, { envId: env?.id ?? loc.p.activeEnv });
      return res;
    }, { iterations: r.iterations, rows: r.rows || [], delayMs: r.delayMs, stopOnFailure: r.stopOnFailure, shouldStop: () => r.stop },
    (result) => { r.results.push(result); if (S.page === 'runner') renderPage(); });
    r.running = false; renderPage();
    const failed = r.results.filter((x) => !x.passed).length;
    notify(failed ? `Run finished: ${failed} of ${r.results.length} failed` : `Run finished: all ${r.results.length} passed`, failed ? 'error' : 'info', 6000);
  },
  'run-stop'() { R().stop = true; },
  async 'run-export'(d) {
    const r = R();
    const name = (r.label || 'run').replace(/[^\w.-]+/g, '_');
    const content = d.format === 'junit' ? toJUnit(r.label || 'run', r.results) : JSON.stringify({ name: r.label, at: new Date().toISOString(), results: r.results }, null, 2);
    const res = await window.electronAPI.saveTextFile(`${name}-results.${d.format === 'junit' ? 'xml' : 'json'}`, content);
    if (res.ok) notify('Saved ' + res.filePath); else if (!res.canceled) notify(res.error, 'error');
  },
};

export function onRunnerInput(el) {
  const r = R();
  if (el.id === 'run-iterations') { r.iterations = Math.max(1, parseInt(el.value, 10) || 1); return true; }
  if (el.id === 'run-delay') { r.delayMs = Math.max(0, parseInt(el.value, 10) || 0); return true; }
  return false;
}
export function onRunnerChange(el) {
  const r = R();
  if (el.id === 'run-scope') { r.scopeKey = el.value; return true; }
  if (el.id === 'run-env') { r.envId = el.value || null; return true; }
  if (el.id === 'run-stop') { r.stopOnFailure = el.checked; return true; }
  return false;
}
