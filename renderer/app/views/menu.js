// Dropdown and context menus. openMenu(items, at) shows one; picking an item runs it.
// Item: { label, run(), hint?, disabled?, danger? } | { sep: true } | { head: 'Section title' }
import { $, esc } from '../../shared/html.js';
import { S } from '../store.js';

// at: an element (menu opens below it) or { x, y } (e.g. a right-click position).
export function openMenu(items, at) {
  let x, y;
  if (at instanceof Element) { const r = at.getBoundingClientRect(); x = r.left; y = r.bottom + 2; } else ({ x, y } = at);
  S.menu = { items, x, y };
  renderMenu();
}

export function closeMenu() { if (S.menu) { S.menu = null; renderMenu(); } }

export function renderMenu() {
  const root = $('menu-root');
  if (!S.menu) { root.innerHTML = ''; return; }
  root.innerHTML = `<div class="menu" role="menu">${S.menu.items.map((it, i) => {
    if (it.sep) return '<div class="menu-sep"></div>';
    if (it.head) return `<div class="menu-head">${esc(it.head)}</div>`;
    return `<button class="menu-item${it.danger ? ' danger' : ''}" role="menuitem" data-action="menu-pick" data-idx="${i}" ${it.disabled ? 'disabled' : ''}>
      <span>${esc(it.label)}</span>${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''}</button>`;
  }).join('')}</div>`;
  // Keep it on screen.
  const el = root.firstElementChild, r = el.getBoundingClientRect();
  el.style.left = Math.max(4, Math.min(S.menu.x, innerWidth - r.width - 4)) + 'px';
  el.style.top = Math.max(4, S.menu.y + r.height > innerHeight ? S.menu.y - r.height - 4 : S.menu.y) + 'px';
  el.querySelector('.menu-item:not([disabled])')?.focus();
}

export function pickMenuItem(i) {
  const item = S.menu?.items[i];
  closeMenu();
  item?.run?.();
}
