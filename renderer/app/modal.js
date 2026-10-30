// A single form dialog.
// spec: { title, ok?, hint?, html? (trusted markup from our own code), wide?, fields: [Field], onOk(values),
//         danger?: { label, run() } (a red button on the left, e.g. Delete; closes the dialog first) };
// values are keyed by field key.
// Field: { key, label, value?, type?: 'text' | 'password' | 'textarea' | 'select' | 'checklist', options? }
//   select options: strings or { value, label }
//   checklist options: [{ value, label, checked? }]; its value is the array of checked values
import { $, esc } from '../shared/html.js';
import { S } from './store.js';

export function openModal(spec) { S.modal = spec; renderModal(); }
export function closeModal() { S.modal = null; renderModal(); }

const opt = (o) => (typeof o === 'string' ? { value: o, label: o } : o);

function fieldHtml(f) {
  const id = `mf-${f.key}`;
  switch (f.type) {
    case 'textarea': return `<textarea id="${id}" rows="8">${esc(f.value || '')}</textarea>`;
    case 'select': return `<select id="${id}">${f.options.map(opt).map((o) =>
      `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    case 'checklist': return `<div id="${id}" class="checklist">${f.options.length ? f.options.map((o) =>
      `<label><input type="checkbox" value="${esc(o.value)}" ${o.checked ? 'checked' : ''}/> <span>${esc(o.label)}</span></label>`).join('') : '<span class="hint">Nothing to choose from.</span>'}</div>`;
    case 'password': return `<input type="password" id="${id}" autocomplete="new-password" value="${esc(f.value || '')}"/>`;
    default: return `<input type="text" id="${id}" value="${esc(f.value || '')}"/>`;
  }
}

function fieldValue(f) {
  const el = $('mf-' + f.key);
  if (f.type === 'checklist') return [...el.querySelectorAll('input:checked')].map((i) => i.value);
  return el.value;
}

export function renderModal() {
  const root = $('modal-root');
  const m = S.modal;
  if (!m) { root.innerHTML = ''; return; }
  root.innerHTML = `<div class="overlay"><div class="modal${m.wide ? ' wide' : ''}"><h3>${esc(m.title)}</h3>
    ${m.hint ? `<p class="mb-8 hint">${esc(m.hint)}</p>` : ''}${m.html || ''}
    ${m.fields.map((f) => `<div class="field"><label class="hint">${esc(f.label)}</label>${fieldHtml(f)}</div>`).join('')}
    <div class="modal-actions">${m.danger ? `<button class="btn-ghost danger-text" data-action="modal-danger" style="margin-right:auto">${esc(m.danger.label)}</button>` : ''}${m.fields.length ? '<button class="btn-ghost" data-action="modal-cancel">Cancel</button>' : ''}
    <button class="btn-primary" data-action="modal-ok">${esc(m.ok || 'OK')}</button></div></div></div>`;
  (root.querySelector('input,textarea,select') || root.querySelector('[data-action=modal-ok]'))?.focus();
}

export function runModalDanger() { const m = S.modal; closeModal(); m?.danger?.run(); }

// Closes the dialog and runs its onOk with the entered values.
export function submitModal() {
  const m = S.modal; if (!m) return;
  const values = Object.fromEntries(m.fields.map((f) => [f.key, fieldValue(f)]));
  closeModal();
  m.onOk?.(values);
}
