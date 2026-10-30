// Keyboard and screen-reader support that applies across views:
// - the sidebar's project / Current lists are ARIA trees: arrow keys move and expand/collapse,
//   Enter opens, F2 renames, Delete deletes (with Undo), Shift+F10 / the menu key opens the row menu;
// - icon-only buttons get an accessible name from their title; inputs labelled only by a
//   placeholder get it as their label;
// - clickable rows that aren't buttons ([data-action] on a div / tr) are focusable and work with
//   Enter / Space.
import { startRename, rowMenu } from './actions/sidebar.js';

const NATIVE = 'button, a, input, select, textarea, summary, option, label';
const ROW = '.sidebar-item[data-kind]';

// ── sidebar tree ────────────────────────────────────────────────────────────────────────────────
function treeRows(list) { return [...list.querySelectorAll(ROW)].filter((el) => el.offsetParent !== null); }

const levelOf = (el) => (el.dataset.kind === 'project' || el.dataset.kind === 'feature' ? 1 : el.dataset.kind === 'folder' || !el.classList.contains('nested') ? 2 : 3);
const expandable = (el) => ['project', 'folder', 'feature'].includes(el.dataset.kind);
const isOpen = (el) => el.querySelector('.icon-chevron-down') !== null;

// Adds tree roles after each sidebar render, keeping one row in the tab order (the active one, else the first).
export function decorateTree(list) {
  if (!list) return;
  list.setAttribute('role', 'tree');
  list.setAttribute('aria-label', list.id === 'current-list' ? 'Features being worked on' : 'Projects and requests');
  const rows = [...list.querySelectorAll(ROW)];
  for (const el of rows) {
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-level', levelOf(el));
    el.tabIndex = -1;
    if (expandable(el)) el.setAttribute('aria-expanded', String(isOpen(el)));
    el.setAttribute('aria-selected', String(el.classList.contains('active')));
  }
  const current = rows.find((el) => el.dataset.id === lastFocus.id && el.dataset.kind === lastFocus.kind) || rows.find((el) => el.classList.contains('active') && el.dataset.kind === 'request') || rows[0];
  if (current) current.tabIndex = 0;
  // Re-renders replace the rows: keep keyboard focus on the same row.
  if (lastFocus.restore && current && current.dataset.id === lastFocus.id) { current.focus(); lastFocus.restore = false; }
}

const lastFocus = { id: null, kind: null, restore: false };

function focusRow(el) {
  if (!el) return;
  for (const r of el.closest('[role=tree]')?.querySelectorAll(ROW) || []) r.tabIndex = -1;
  el.tabIndex = 0; el.focus();
  Object.assign(lastFocus, { id: el.dataset.id, kind: el.dataset.kind });
}

// Clicking a row re-renders the list; the focus comes back to it afterwards.
function activate(el) { Object.assign(lastFocus, { id: el.dataset.id, kind: el.dataset.kind, restore: true }); el.click(); }

function parentRow(rows, i) {
  const level = levelOf(rows[i]);
  for (let j = i - 1; j >= 0; j--) if (levelOf(rows[j]) < level) return rows[j];
  return null;
}

function onTreeKey(e) {
  const el = e.target.closest?.(ROW);
  if (!el || e.target !== el || e.altKey || e.metaKey || e.ctrlKey) return;
  const rows = treeRows(el.closest('[role=tree]') || el.parentElement), i = rows.indexOf(el);
  const handled = () => { e.preventDefault(); e.stopPropagation(); };
  switch (e.key) {
    case 'ArrowDown': handled(); return focusRow(rows[Math.min(rows.length - 1, i + 1)]);
    case 'ArrowUp': handled(); return focusRow(rows[Math.max(0, i - 1)]);
    case 'Home': handled(); return focusRow(rows[0]);
    case 'End': handled(); return focusRow(rows.at(-1));
    case 'ArrowRight':
      handled();
      if (expandable(el) && !isOpen(el)) return activate(el);
      return focusRow(rows[i + 1] && levelOf(rows[i + 1]) > levelOf(el) ? rows[i + 1] : el);
    case 'ArrowLeft':
      handled();
      if (expandable(el) && isOpen(el)) return activate(el);
      return focusRow(parentRow(rows, i) || el);
    case 'Enter': case ' ': handled(); return activate(el);
    case 'F2': handled(); return startRename(el.dataset.kind, el.dataset.id, el.dataset.pid);
    case 'Delete': {
      if (el.dataset.kind === 'feature') return;
      const del = rowMenu(el.dataset.kind, el.dataset.id, el.dataset.pid).find((m) => m.danger);
      if (del) { handled(); del.run(); }
      return;
    }
    case 'ContextMenu': case 'F10':
      if (e.key === 'F10' && !e.shiftKey) return;
      handled();
      { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.bottom })); }
      return;
    default:
  }
}

// ── names and focusability everywhere ────────────────────────────────────────────────────────────
const textless = (el) => !/[\p{L}\p{N}]/u.test(el.textContent || '');

function label(root) {
  for (const b of root.querySelectorAll?.('button:not([aria-label])') || []) {
    if (textless(b) && b.title) b.setAttribute('aria-label', b.title);
  }
  for (const inp of root.querySelectorAll?.('input:not([aria-label]):not([type=checkbox]):not([type=radio]), textarea:not([aria-label])') || []) {
    if (!inp.labels?.length && inp.placeholder) inp.setAttribute('aria-label', inp.placeholder.split('\n')[0].slice(0, 80));
  }
  for (const el of root.querySelectorAll?.('[data-action]') || []) {
    if (el.matches(NATIVE) || el.matches(ROW) || el.hasAttribute('role') || el.closest('.menu')) continue;
    el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
  }
}

export function wireA11y() {
  document.addEventListener('keydown', onTreeKey, true);
  // Enter / Space on clickable non-button elements.
  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if ((e.key === 'Enter' || e.key === ' ') && ['button', 'tab'].includes(el?.getAttribute?.('role')) && !el.matches(NATIVE)) { e.preventDefault(); el.click(); }
  });
  for (const id of ['sidebar-list', 'current-list']) {
    const list = document.getElementById(id);
    if (list) new MutationObserver(() => decorateTree(list)).observe(list, { childList: true });
  }
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; label(document.body); }, 60); // batched: streams and traffic update often
  }).observe(document.body, { childList: true, subtree: true });
  label(document.body);
}
