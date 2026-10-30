// DOM/HTML helpers shared by every page. Views are built as HTML strings, so every
// interpolated value must go through esc().
export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const copyText = (text) => navigator.clipboard.writeText(text ?? '');

// Briefly swap a button's label for a ✓ after an action.
export function flashDone(btn, ms = 900) {
  const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
  btn.textContent = '✓';
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => { btn.textContent = label; }, ms);
}
