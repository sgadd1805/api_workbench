import { esc } from '../../shared/html.js';
import { icon } from '../../shared/icons.js';

// Editable key/value rows. Inputs carry data-list / data-idx / data-k, which events.js maps back
// to the list via listFor() in actions/rows.js; "+ Add" and "×" are the add-kv / del-kv actions.
// options: { toggle (show the enable checkbox, default true), keyPh, valPh, extraRow (render one more empty row),
//            secretToggle (a 🔒 button per row; secret values are masked on screen and left out of exports and History) }
export function kvRows(list, listName, { toggle = true, keyPh = 'key', valPh = 'value', extraRow = false, secretToggle = false } = {}) {
  const rows = extraRow ? [...list, { k: '', v: '', on: true }] : list;
  const attrs = (i, k) => `data-list="${listName}" data-idx="${i}" data-k="${k}"`;
  return rows.map((h, i) => `<div class="kv-row${toggle ? '' : ' no-toggle'}${secretToggle ? ' with-secret' : ''}">
      ${toggle ? `<input type="checkbox" ${attrs(i, 'on')} ${h.on ? 'checked' : ''}/>` : ''}
      <input type="text" ${attrs(i, 'k')} value="${esc(h.k)}" placeholder="${esc(keyPh)}" spellcheck="false"/>
      <input type="${h.secret ? 'password' : 'text'}" ${attrs(i, 'v')} value="${esc(h.v)}" placeholder="${esc(valPh)}" spellcheck="false" ${h.secret ? 'autocomplete="new-password"' : ''}/>
      ${secretToggle ? `<button class="btn-ghost small${h.secret ? ' compare-active' : ''}" data-action="row-secret" data-list="${listName}" data-idx="${i}" title="${h.secret ? 'Secret: masked here, redacted in History, left out of exports' : 'Mark as secret'}" aria-pressed="${!!h.secret}">🔒</button>` : ''}
      <button class="btn-ghost small" data-action="del-kv" data-list="${listName}" data-idx="${i}" title="Remove">${icon('close')}</button></div>`).join('') +
    `<button class="btn-ghost small" data-action="add-kv" data-list="${listName}">+ Add</button>`;
}
