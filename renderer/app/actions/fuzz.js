// Fuzz page (S.page === 'fuzz'): sends each request of a scope that's matched to a spec operation once as it is
// (the baseline), then once per case from openapi/fuzz.js, and flags server errors, invalid input that was
// accepted, endpoints that work without credentials, and responses that don't match the spec.
// Nothing is stored by these sends (no History, cookies, extract rules or variables).
import { notify } from '../../shared/notify.js';
import { copyText, flashDone } from '../../shared/html.js';
import { S, currentProject, findReq, addRequest, newReq, saveDB } from '../store.js';
import { send } from '../http.js';
import { requestsInScope, scopeOf } from '../runner.js';
import { ensureProjectSpecs, operationFor } from '../openapi/registry.js';
import { fuzzCases, judgeCase } from '../openapi/fuzz.js';
import { toCurl } from '../curl.js';
import { savableHeaders } from '../replay.js';
import { isJson } from '../../shared/json.js';
import { renderPage } from '../views/index.js';
import { openModal } from '../modal.js';
import { openReq, setPage } from './core.js';

const F = () => S.fuzz;
const MAX_KEPT_BODY = 4000;
const short = (s) => (typeof s === 'string' && s.length > MAX_KEPT_BODY ? s.slice(0, MAX_KEPT_BODY) + `\n… (${s.length - MAX_KEPT_BODY} more characters)` : s ?? '');
// The wire as shown and saved: oversized values shortened in the display copy only.
const keepWire = (w) => ({ method: w.method, url: w.url, headers: w.headers, body: w.body, ...(w.bodyParts && { bodyParts: w.bodyParts }), ...(w.bodyFile && { bodyFile: w.bodyFile }) });

export const fuzzActions = {
  'open-fuzz'(d) {
    const f = F();
    if (d?.scope) f.scopeKey = d.scope;
    else if (S.req && S.page === 'request') f.scopeKey = `request|${S.req.id}`;
    else if (!f.scopeKey) { const p = currentProject(); if (p) f.scopeKey = `project|${p.id}`; }
    setPage('fuzz');
  },
  'fuzz-start'() { startFuzz(); },
  'fuzz-stop'() { F().stop = true; },
  'fuzz-toggle'(d) { const f = F(); f.open[d.id] = !f.open[d.id]; renderPage(); },
  'fuzz-case'(d) { const f = F(); f.selected = f.selected === d.id ? null : d.id; renderPage(); },
  'fuzz-only-problems'() { const f = F(); f.onlyProblems = !f.onlyProblems; renderPage(); },
  'fuzz-curl'(d, el) { const c = findCase(d.id); if (c) { copyText(toCurl(c.wire)); flashDone(el); } },
  'fuzz-save'(d) { saveCase(d.id); },
};

function findCase(id) {
  for (const g of F().results) { const c = g.cases.find((x) => x.id === id); if (c) return { ...c, group: g }; }
  return null;
}

// The scope as request locations: one request ('request|id'), or a folder / project / feature like the runner.
function scopeLocs(key) {
  if (key?.startsWith('request|')) { const loc = findReq(key.slice(8)); return loc ? [loc] : []; }
  return requestsInScope(scopeOf(key));
}

async function startFuzz() {
  const f = F();
  if (f.running) return;
  const locs = scopeLocs(f.scopeKey || document.getElementById('fuzz-scope')?.value).filter((l) => !l.r.kind || l.r.kind === 'http');
  if (!locs.length) return notify('No HTTP requests there', 'error');
  await Promise.all([...new Set(locs.map((l) => l.p))].map(ensureProjectSpecs));
  const env = f.envId ? locs[0].p.envs.find((e) => e.id === f.envId) : null;
  Object.assign(f, { running: true, stop: false, results: [], selected: null, open: {}, skipped: [], progress: { done: 0, total: 0 } });
  renderPage();
  for (const loc of locs) {
    if (f.stop) break;
    if (loc.r.method === 'DELETE' && !f.includeDelete) { f.skipped.push(`${loc.r.name}: DELETE (tick "Include DELETE requests")`); continue; }
    // The baseline: the request as it is, which tells us what it sends and whether it works at all.
    const base = await send(loc, undefined, { env: env || undefined, sideEffects: false });
    if (!base.requestData) { f.skipped.push(`${loc.r.name}: ${base.error || 'could not be built'}`); continue; }
    // Rejected for credentials as saved: every case would be too, which says nothing about its input.
    if (base.status === 401 || base.status === 403) { f.skipped.push(`${loc.r.name}: got ${base.status} as saved; set its auth (or pick an environment with credentials) first`); continue; }
    const match = operationFor(loc, base.requestData.method, base.requestData.url);
    if (!match) { f.skipped.push(`${loc.r.name}: no matching operation in the project's specs`); continue; }
    const cases = fuzzCases(match.analysis, match.op, base.requestData, match.pathParams, { oversized: f.oversized, max: f.maxPerOp });
    const group = { reqId: loc.r.id, name: loc.r.name, method: loc.r.method, op: match.op.key, spec: match.meta.title,
      baseline: base.error ? { error: base.error } : { status: base.status, time: base.time }, cases: [] };
    f.results.push(group);
    f.open[loc.r.id] = true;
    f.progress.total += cases.length;
    renderPage();
    for (const c of cases) {
      if (f.stop) break;
      const res = await send(loc, undefined, { env: env || undefined, sideEffects: false, mutate: c.mutate });
      const { verdict, issues } = judgeCase(c, res, match.analysis, match.op);
      group.cases.push({ id: `${loc.r.id}:${c.id}`, label: c.label, where: c.where, group: c.group, expect: c.expect, verdict, issues,
        status: res.status ?? null, time: res.time ?? null, error: res.error || null,
        wire: keepWire(res.requestData || {}), response: res.error ? null : { status: res.status, headers: res.headers, body: short(res.body) } });
      f.progress.done++;
      if (S.page === 'fuzz') renderPage();
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
    }
  }
  f.running = false;
  renderPage();
  const all = f.results.flatMap((g) => g.cases);
  const bad = all.filter((c) => ['server-error', 'accepted', 'auth-open', 'no-response'].includes(c.verdict)).length;
  notify(all.length ? `Fuzzing ${f.stop ? 'stopped' : 'finished'}: ${all.length} cases, ${bad} problem${bad === 1 ? '' : 's'}` : 'Nothing to fuzz: no request matched a spec operation', bad ? 'error' : 'info', 7000);
}

// A failing case as a saved request next to the original, to reproduce and debug it.
function saveCase(id) {
  const c = findCase(id); if (!c) return;
  const loc = findReq(c.group.reqId);
  const p = loc?.p || currentProject(); if (!p) return;
  const w = c.wire;
  openModal({ title: 'Save case as a request', ok: 'Save', hint: 'Saved exactly as it was sent (variables resolved, auth as a header).',
    fields: [{ key: 'name', label: 'Name', value: `${c.group.name} — ${c.label} (${c.where})`.slice(0, 120) }],
    onOk: (v) => {
      const body = w.bodyParts ? { type: 'multipart', text: '', form: w.bodyParts.map((x) => (x.file != null ? { k: x.name, v: x.file, on: true, file: true } : { k: x.name, v: x.value ?? '', on: true })) }
        : w.bodyFile ? { type: 'binary', text: '', form: [], file: w.bodyFile }
        : w.body ? { type: isJson(w.body) ? 'json' : 'raw', text: w.body, form: [] } : { type: 'none', text: '', form: [] };
      const headers = savableHeaders(w.headers);
      const r = addRequest(p, loc?.f || null, newReq({ name: v.name.trim() || c.label, method: w.method, url: w.url, headers, body, auth: { type: 'none' }, ...(loc?.r.spec && { spec: { ...loc.r.spec } }) }));
      saveDB(); openReq(r.id); notify('Saved; it\'s in the same folder as the original');
    } });
}

export function onFuzzInput(el) {
  const f = F();
  const num = (min, max) => Math.max(min, Math.min(max, parseInt(el.value, 10) || 0));
  if (el.id === 'fuzz-max') { f.maxPerOp = num(1, 500) || 60; return true; }
  if (el.id === 'fuzz-delay') { f.delayMs = num(0, 60000); return true; }
  return false;
}
export function onFuzzChange(el) {
  const f = F();
  if (el.id === 'fuzz-scope') { f.scopeKey = el.value; return true; }
  if (el.id === 'fuzz-env') { f.envId = el.value || null; return true; }
  if (el.id === 'fuzz-oversized') { f.oversized = el.checked; return true; }
  if (el.id === 'fuzz-delete') { f.includeDelete = el.checked; return true; }
  return onFuzzInput(el);
}
