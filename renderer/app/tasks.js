// Tasks (local services under test) and log sources: their live state and log lines on this side,
// fed by main/tasks.js and main/logs.js.
//
// Project.tasks: [{ id, name, command, cwd, javaHome, profile, jvmOpts, env: [Row], readyLog, readyUrl, waitForReady }]
// Project.logSources: [{ id, name, type: 'file' | 'command', path, command, running }]
import { uid, findReq } from './store.js';
import { otelEnvFor } from './actions/otel.js';

const MAX_LINES = 5000;
const states = new Map(); // task id → { state: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed', port, … }
const lines = new Map();  // task / log source id → [line]
const listeners = new Set();
const waiters = new Map(); // task id → [resolve] waiting for 'ready' (or a final state)

export const taskState = (id) => states.get(id)?.state || 'stopped';
export const taskInfo = (id) => states.get(id) || { state: 'stopped' };
export const logLines = (id) => lines.get(id) || [];
export const onTasksChanged = (fn) => listeners.add(fn);
const changed = (what) => { for (const fn of listeners) fn(what); };

export function initTasks() {
  window.electronAPI.onTaskState((s) => {
    states.set(s.id, s);
    if (['ready', 'stopped', 'failed'].includes(s.state)) { for (const done of waiters.get(s.id) || []) done(s.state); waiters.delete(s.id); }
    changed({ task: s.id });
  });
  window.electronAPI.onLogLines(({ id, lines: added }) => {
    const list = lines.get(id) || [];
    list.push(...added);
    if (list.length > MAX_LINES) list.splice(0, list.length - MAX_LINES);
    lines.set(id, list);
    changed({ log: id });
  });
  window.electronAPI.taskStates().then((all) => { for (const s of all) states.set(s.id, s); changed({}); });
}

export const newTask = (fields = {}) => ({ id: uid(), name: 'New task', command: '', cwd: '', javaHome: '', profile: '', jvmOpts: '', env: [], readyLog: '', readyUrl: '', waitForReady: true, ...fields });
export const newLogSource = (fields = {}) => ({ id: uid(), name: 'New log source', type: 'ssh', path: '', command: '', ...sourceParts(), ...fields });

// The per-type settings of a log source (older sources may lack them).
// type: 'ssh' (files on a server) | 'kubernetes' | 'docker' | 'file' (this computer) | 'command'
export function sourceParts(s = {}) {
  return {
    ssh: { host: '', user: '', port: '', identityFile: '', paths: '', ...s.ssh },
    k8s: { context: '', namespace: '', target: '', selector: '', container: '', ...s.k8s },
    docker: { container: '', ...s.docker },
  };
}

// What main/logs.js and main/serverlogs.js need to follow or search a source.
export function sourceDef(p, s) {
  return { id: s.id, name: s.name, type: s.type, path: s.path, command: s.command, cwd: p?.codeFolder || undefined, ...sourceParts(s) };
}

// Sources whose logs can be searched where they live (a command source only has its live lines).
export const SEARCHABLE = new Set(['ssh', 'kubernetes', 'docker', 'file']);

// The definition main/tasks.js runs: a relative working folder is resolved against the project's code folder.
export function taskDef(p, t) {
  const base = p.codeFolder || '';
  const cwd = !t.cwd ? base : /^([/\\]|[A-Za-z]:)/.test(t.cwd) ? t.cwd : base ? `${base.replace(/[/\\]$/, '')}/${t.cwd}` : t.cwd;
  return { ...t, cwd, env: [...t.env.filter((r) => r.on && r.k), ...otelEnvFor(t)] };
}

// Waits until the task is ready (or ends), up to ms. → final state or 'timeout'.
export function whenReady(id, ms = 180000) {
  if (taskState(id) !== 'starting') return Promise.resolve(taskState(id));
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    const list = waiters.get(id) || [];
    list.push((s) => { clearTimeout(timer); resolve(s); });
    waiters.set(id, list);
  });
}

// Log ids searched for a request's lines: the project's tasks and log sources.
export const logIdsFor = (p) => [...(p?.tasks || []).map((t) => t.id), ...(p?.logSources || []).map((s) => s.id)];

// ---- correlation ids stamped on each send (when the project has them on)
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
export function newCorrelation() {
  const traceId = hex(16), spanId = hex(8);
  return { requestId: crypto.randomUUID(), traceId, traceparent: `00-${traceId}-${spanId}-01` };
}

export const projectOf = (reqId) => findReq(reqId)?.p || null;
