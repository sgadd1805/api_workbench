import { esc, copyText } from '../../shared/html.js';
import { formatXml } from '../lib/xml.js';
import { PRE } from '../lib/ui.js';

export default {
  id: 'xml', label: 'XML',
  state: { xmlInput: '' },
  keys: ['xmlInput'],
  primary: (S) => S.xmlInput,
  receive(S, value) { S.xmlInput = value; },
  render(S) {
    const out = S.xmlInput.trim() ? formatXml(S.xmlInput) : null;
    const bad = S.xmlInput.trim() && out === null;
    return `<div style="display:flex;gap:8px"><div style="flex:1"><label class="hint">Input</label><textarea id="xml-input" rows="18" spellcheck="false">${esc(S.xmlInput)}</textarea>${bad ? '<p class="error-text">Invalid XML</p>' : ''}</div>
      <div style="flex:1"><label class="hint">Formatted</label><pre style="${PRE};min-height:300px">${out ? esc(out) : ''}</pre><button class="btn-ghost small" id="xml-copy">Copy</button></div></div>`;
  },
  onInput(el, ctx) {
    if (el.id === 'xml-input') { ctx.S.xmlInput = el.value; ctx.changed(el); }
  },
  onClick(t, { S }) {
    if (t.id === 'xml-copy') copyText(formatXml(S.xmlInput) || '');
  },
};
