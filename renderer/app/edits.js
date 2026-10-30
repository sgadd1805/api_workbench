// Undo / redo for edits (⌘Z / ⌘⇧Z, Ctrl+Z / Ctrl+Y outside text fields; ⌘K "Undo"). Each save of the data
// (store.js flushDB) is compared with the last one, item by item — every request, every environment, each
// project's own settings and structure (which folders and requests it has, in what order), the order of the
// projects, and the feature groups, notes and token sources — and the items that changed become one step.
// Undo puts those items back as they were, leaving everything else alone, so it doesn't also roll back a
// token or cookie a send stored meanwhile: changes made by sends (markAutomatic) aren't steps at all.
// App settings (theme, layout …) aren't undone. Inside a text field, ⌘Z is the field's own undo.
import { DB } from './store.js';

const MAX_STEPS = 100;
let base = null;          // unit key → JSON at the last save
let undoStack = [], redoStack = [];
let automatic = false;    // the next save comes from a send (extract rules, cookies, script vars)
let applying = false;

// The data as units: key → JSON text.
export function unitsOf(db) {
  const out = new Map();
  for (const p of db.projects || []) {
    for (const r of [...(p.requests || []), ...(p.folders || []).flatMap((f) => f.requests || [])]) out.set(`r:${r.id}`, JSON.stringify(r));
    for (const e of p.envs || []) out.set(`e:${e.id}`, JSON.stringify(e));
    out.set(`p:${p.id}`, JSON.stringify({ ...p, requests: (p.requests || []).map((r) => r.id), folders: (p.folders || []).map((f) => ({ ...f, requests: (f.requests || []).map((r) => r.id) })), envs: (p.envs || []).map((e) => e.id) }));
  }
  out.set('order', JSON.stringify((db.projects || []).map((p) => p.id)));
  for (const k of ['features', 'notes', 'tokenSources']) out.set(k, JSON.stringify(db[k] || []));
  return out;
}

// → [{ key, before, after }] (before / after: JSON text, or undefined when the item didn't / doesn't exist)
function changes(from, to) {
  const out = [];
  for (const key of new Set([...from.keys(), ...to.keys()])) if (from.get(key) !== to.get(key)) out.push({ key, before: from.get(key), after: to.get(key) });
  return out;
}

// What a step changed, for the notification: "Get pet", "environment dev", "project Shop" …
function describe(step) {
  // A whole project added or removed is just that project, not each of its requests.
  const whole = step.filter((c) => c.key.startsWith('p:') && (c.before === undefined || c.after === undefined));
  if (whole.length) return whole.map((c) => `project “${JSON.parse(c.after ?? c.before).name}”`).join(' and ');
  const names = [];
  for (const c of step) {
    const v = JSON.parse(c.after ?? c.before ?? 'null');
    if (c.key.startsWith('r:')) names.push(`“${v?.name}”`);
    else if (c.key.startsWith('e:')) names.push(`environment “${v?.name}”`);
    else if (c.key.startsWith('p:')) names.push(`project “${v?.name}”`);
    else if (c.key !== 'order') names.push({ features: 'feature groups', notes: 'notes', tokenSources: 'token sources' }[c.key]);
  }
  const unique = [...new Set(names)];
  return unique.length > 2 ? `${unique.slice(0, 2).join(', ')} and ${unique.length - 2} more` : unique.join(' and ') || 'the project order';
}

// Called after every save. → the step recorded, or null
export function track(db = DB) {
  const now = unitsOf(db);
  if (!base || applying) { base = now; return null; }
  const step = changes(base, now);
  base = now;
  // The mark covers this one save, whether or not it changed anything undoable.
  const bySend = automatic; automatic = false;
  if (!step.length || bySend) return null;
  undoStack.push(step);
  if (undoStack.length > MAX_STEPS) undoStack.shift();
  redoStack = [];
  return step;
}
export const markAutomatic = () => { automatic = true; };
export function resetEdits(db = DB) { base = unitsOf(db); undoStack = []; redoStack = []; automatic = false; }
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

// Puts each unit of `step` to its `side` ('before' for undo, 'after' for redo), in place, so open tabs keep
// pointing at the same request objects where those still exist.
function apply(db, step, side) {
  const reqs = new Map(), envs = new Map();
  for (const p of db.projects) {
    for (const r of [...p.requests, ...p.folders.flatMap((f) => f.requests)]) reqs.set(r.id, r);
    for (const e of p.envs) envs.set(e.id, e);
  }
  const put = (pool, id, json) => {
    if (json === undefined) return;
    const fresh = JSON.parse(json), obj = pool.get(id);
    if (obj) { for (const k of Object.keys(obj)) delete obj[k]; Object.assign(obj, fresh); } else pool.set(id, fresh);
  };
  for (const c of step) {
    if (c.key.startsWith('r:')) put(reqs, c.key.slice(2), c[side]);
    else if (c.key.startsWith('e:')) put(envs, c.key.slice(2), c[side]);
    else if (['features', 'notes', 'tokenSources'].includes(c.key)) db[c.key] = JSON.parse(c[side] ?? '[]');
  }
  // Project structure: rebuilt from the ids in its unit (a project whose unit didn't change keeps its arrays).
  for (const c of step.filter((x) => x.key.startsWith('p:'))) {
    const id = c.key.slice(2), at = db.projects.findIndex((p) => p.id === id);
    if (c[side] === undefined) { if (at >= 0) db.projects.splice(at, 1); continue; }
    const shape = JSON.parse(c[side]);
    const p = { ...shape, requests: shape.requests.map((rid) => reqs.get(rid)).filter(Boolean),
      folders: shape.folders.map((f) => ({ ...f, requests: f.requests.map((rid) => reqs.get(rid)).filter(Boolean) })), envs: shape.envs.map((eid) => envs.get(eid)).filter(Boolean) };
    if (at >= 0) { const obj = db.projects[at]; for (const k of Object.keys(obj)) delete obj[k]; Object.assign(obj, p); } else db.projects.push(p);
  }
  const order = step.find((c) => c.key === 'order')?.[side];
  if (order) { const ids = JSON.parse(order); db.projects.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); }
}

// → a description of what was undone / redone, or null when there's nothing to do. save: writes the result.
export function undo(db = DB, save = () => {}) { return move(db, undoStack, redoStack, 'before', save); }
export function redo(db = DB, save = () => {}) { return move(db, redoStack, undoStack, 'after', save); }
function move(db, from, to, side, save) {
  const step = from.pop(); if (!step) return null;
  applying = true;
  try { apply(db, step, side); save(); } finally { applying = false; }
  base = unitsOf(db);
  to.push(step);
  return describe(step);
}
