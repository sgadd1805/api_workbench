import { esc, copyText } from '../../shared/html.js';
import { STRING_OPS } from '../lib/strings.js';

const OPS = Object.fromEntries(STRING_OPS.map(([id, , fn]) => [id, fn]));

export default {
  id: 'string', label: 'String',
  state: { stringInput: '' },
  keys: ['stringInput'],
  primary: (S) => S.stringInput,
  receive(S, value) { S.stringInput = value; },
  render(S) {
    const s = S.stringInput, words = (s.trim().match(/\S+/g) || []).length, lines = s ? s.split('\n').length : 0;
    const stat = (n, label) => `<span><strong>${n}</strong> <span class="hint">${label}</span></span>`;
    return `<textarea id="string-input" rows="12" spellcheck="false">${esc(s)}</textarea>
      <div style="display:flex;gap:16px;margin:8px 0;font-size:12px">${stat(s.length, 'chars')}${stat(words, 'words')}${stat(lines, 'lines')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${STRING_OPS.map(([id, label]) => `<button class="btn-ghost small" data-str-op="${id}">${label}</button>`).join('')}<button class="btn-ghost small" id="string-copy">Copy</button></div>`;
  },
  onInput(el, ctx) {
    if (el.id === 'string-input') { ctx.S.stringInput = el.value; ctx.changed(el); }
  },
  onClick(t, { S, recordSoon, rerender }) {
    const op = t.closest('[data-str-op]');
    if (op) { S.stringInput = OPS[op.dataset.strOp](S.stringInput); recordSoon(); rerender(); }
    else if (t.id === 'string-copy') copyText(S.stringInput);
  },
};
