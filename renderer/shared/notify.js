// Notifications: a transient toast in the bottom-right corner, plus a list of recent ones (shown from
// the status bar's bell) so errors that vanish from the toast can still be read. kind: 'info' | 'error'.
const MAX_KEPT = 100;
const kept = []; // newest first: { at, message, kind, seen }
const listeners = new Set();

let timer = null;
// action: { label, run() } adds a button to the toast (e.g. Undo); clicking it runs once and hides the toast.
export function notify(message, kind = 'info', ms = 4000, action = null) {
  kept.unshift({ at: Date.now(), message: String(message), kind, seen: false });
  if (kept.length > MAX_KEPT) kept.length = MAX_KEPT;
  let el = document.getElementById('notice');
  if (!el) { el = document.createElement('div'); el.id = 'notice'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = message;
  el.className = 'notice ' + kind + (action ? ' has-action' : '');
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'notice-action'; btn.textContent = action.label;
    btn.addEventListener('click', () => { el.className = 'notice'; action.run(); }, { once: true });
    el.append(' ', btn);
  }
  clearTimeout(timer);
  timer = setTimeout(() => { el.className = 'notice'; }, ms);
  for (const fn of listeners) fn();
}

export const notifications = () => kept;
export const unseenErrors = () => kept.filter((n) => !n.seen && n.kind === 'error').length;
export const unseenCount = () => kept.filter((n) => !n.seen).length;
export function markAllSeen() { for (const n of kept) n.seen = true; for (const fn of listeners) fn(); }
export function clearNotifications() { kept.length = 0; for (const fn of listeners) fn(); }
export const onNotificationsChanged = (fn) => listeners.add(fn);
