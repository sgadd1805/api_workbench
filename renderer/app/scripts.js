// Pre-request and post-response scripts (project first, then request). Each runs in its own worker
// (script-worker.js) with a time limit. Scripts see:
//   request  { method, url, headers, body }  — editable in pre-request scripts
//   response { status, statusText, headers, body, time, json(), header(name) }  — post-response only
//   vars.get / vars.set / vars.all  — the active environment (+ runner data); set() is saved to it
//   log(...), test(name, fn), expect(x).toBe/toEqual/toContain/toBeTruthy, setNextRequest(name)
//   ctx.uuid(), ctx.now(), ctx.crypto.hmac(algo, key, msg, 'hex'|'base64'), ctx.crypto.sha(algo, msg), ctx.crypto.base64(s)
// Scripts and assertions run in a sandboxed worker (script-worker.js): no app API, no network.
import { workerMain } from './script-worker.js';

export const SCRIPT_TIMEOUT_MS = 5000;

// A Blob URL for the sandbox, so the worker inherits the page's CSP (no network, no remote imports).
let workerUrl = null;
const sandboxUrl = () => (workerUrl ||= URL.createObjectURL(new Blob([`(${workerMain.toString()})();`], { type: 'text/javascript' })));

// Assertions (JS expressions over status and body) → [{ expr, ok, err? }], evaluated in the sandbox.
export function runAssertions(list, status, body, timeoutMs = 2000) {
  const exprs = (list || []).filter((l) => l && l.trim());
  if (!exprs.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    const worker = new Worker(sandboxUrl());
    const timer = setTimeout(() => { worker.terminate(); resolve(exprs.map((expr) => ({ expr, ok: false, err: 'timed out' }))); }, timeoutMs);
    worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data.assertions); };
    worker.onerror = (e) => { clearTimeout(timer); worker.terminate(); resolve(exprs.map((expr) => ({ expr, ok: false, err: e.message || 'error' }))); };
    worker.postMessage({ phase: 'assert', assertions: exprs, status, body });
  });
}

export function runScript(code, phase, input, timeoutMs = SCRIPT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const worker = new Worker(sandboxUrl());
    const timer = setTimeout(() => { worker.terminate(); resolve({ ok: false, error: `Script stopped after ${timeoutMs / 1000} s (infinite loop?)`, request: input.request, setVars: {}, tests: [], logs: [] }); }, timeoutMs);
    worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
    worker.onerror = (e) => { clearTimeout(timer); worker.terminate(); resolve({ ok: false, error: e.message || 'Script error', request: input.request, setVars: {}, tests: [], logs: [] }); };
    worker.postMessage({ code, phase, ...input });
  });
}

// The scripts that apply to a request, in order: project, then the request's own.
export function scriptsFor(loc, phase) {
  return [loc.p.scripts?.[phase], loc.r.scripts?.[phase]].filter((c) => c && c.trim());
}

// Runs a phase's scripts one after another, threading the request and variables through.
// → { request, setVars, tests, logs, errors, next }
export async function runPhase(loc, phase, { request, response, vars }) {
  const out = { request, setVars: {}, tests: [], logs: [], errors: [], next: undefined };
  for (const code of scriptsFor(loc, phase)) {
    const r = await runScript(code, phase, { request: out.request, response, vars: { ...vars, ...out.setVars } });
    out.request = r.request || out.request;
    Object.assign(out.setVars, r.setVars || {});
    out.tests.push(...(r.tests || []));
    out.logs.push(...(r.logs || []));
    if (r.next !== undefined) out.next = r.next;
    if (!r.ok) { out.errors.push(r.error); break; }
  }
  return out;
}

// Applies a pre-request script's edits to a freshly built wire request: changed url/method/body win,
// header edits (added, changed, removed) are replayed on top.
export function applyRequestEdits(before, after, rebuilt) {
  const out = { ...rebuilt, headers: { ...rebuilt.headers } };
  for (const k of ['url', 'method', 'body']) if (after[k] !== before[k]) out[k] = after[k];
  for (const [k, v] of Object.entries(after.headers || {})) if (before.headers?.[k] !== v) out.headers[k] = v;
  for (const k of Object.keys(before.headers || {})) if (!(k in (after.headers || {}))) delete out.headers[k];
  return out;
}
