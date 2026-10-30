// Variable history: every change to an environment variable — by an extract rule, a script's vars.set(),
// a captured login session, or an edit on the Environments page — with when, the old and new value, and what
// did it. Shown on the Environments page, in the URL field's {{variable}} tooltip and from ⌘K. Kept on this
// computer (localStorage), newest first; secret variables' values are never kept, only that they changed.
const KEY = 'var-history';
const MAX = 500;
const MAX_VALUE = 200;
const EDIT_MERGE_MS = 5000; // typing in a field is one change, not one per keystroke

let log = null;
const store = () => {
  if (!log) { try { log = JSON.parse(globalThis.localStorage?.getItem(KEY) || '[]'); } catch { log = []; } }
  return log;
};
let saveTimer = 0;
const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { globalThis.localStorage?.setItem(KEY, JSON.stringify(log)); } catch { /* full or unavailable: kept in memory */ } }, 300); };
const shown = (v, secret) => (secret ? '••••••' : v == null ? '' : String(v).slice(0, MAX_VALUE));
// Names that hold credentials, whether or not the variable is marked secret: their values aren't kept either.
export const secretLooking = (name) => /(token|secret|password|passwd|pwd|api[-_]?key|apikey|credential|cookie|session|csrf|xsrf|auth|signature)/i.test(String(name));

// p: the project; env: the environment; source: what set it ("Log in: extract access_token", "script", …).
// kind: 'extract' | 'script' | 'edit' | 'capture' | 'other'
export function recordVar({ p, env, name, before, value, secret = false, source = '', kind = 'other', now = Date.now() }) {
  if (!name || before === value) return null;
  secret = secret || secretLooking(name);
  const list = store();
  const last = list[0];
  if (kind === 'edit' && last && last.kind === 'edit' && last.envId === env?.id && last.name === name && now - last.at < EDIT_MERGE_MS) {
    Object.assign(last, { at: now, value: shown(value, secret) }); persist(); return last;
  }
  const entry = { at: now, projectId: p?.id ?? null, projectName: p?.name ?? '', envId: env?.id ?? null, envName: env?.name ?? '', name, before: shown(before, secret), value: shown(value, secret), secret: !!secret, source, kind };
  list.unshift(entry);
  if (list.length > MAX) list.length = MAX;
  persist();
  return entry;
}

// Newest first. filter: { projectId?, envId?, name? }
export function varHistory({ projectId, envId, name } = {}) {
  return store().filter((e) => (projectId == null || e.projectId === projectId) && (envId == null || e.envId === envId) && (name == null || e.name === name));
}
export const lastChange = (envId, name) => store().find((e) => e.envId === envId && e.name === name) || null;
export function clearVarHistory() { log = []; persist(); }
// For tests: forget the in-memory copy.
export function resetVarHistory(list = []) { log = list; }
