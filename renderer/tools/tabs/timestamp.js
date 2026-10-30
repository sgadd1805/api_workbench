import { esc } from '../../shared/html.js';
import { relTime, parseTimestamp } from '../lib/time.js';

function details(v) {
  const d = parseTimestamp(v);
  if (isNaN(d)) return '<p class="error-text">Unrecognized date</p>';
  const row = (label, x) => `<span class="hint">${label}</span><code style="font-family:monospace">${esc(x)}</code>`;
  return `<div style="display:grid;grid-template-columns:120px 1fr;gap:6px 12px;font-size:12px;margin-top:12px;align-items:center">
    ${row('Unix (s)', Math.floor(d.getTime() / 1000))}${row('Unix (ms)', d.getTime())}${row('ISO 8601', d.toISOString())}
    ${row('UTC', d.toUTCString())}${row('Local', d.toLocaleString())}${row('Relative', relTime(d))}</div>`;
}

export default {
  id: 'timestamp', label: 'Timestamp',
  state: { tsInput: '' },
  keys: ['tsInput'],
  primary: (S) => S.tsInput,
  receive(S, value) { S.tsInput = value.trim(); },
  render: (S) => `<div style="display:flex;gap:8px"><input type="text" id="ts-input" style="flex:1" placeholder="Unix seconds / ms or date string" value="${esc(S.tsInput)}"/>
    <button class="btn-ghost small" id="ts-now">Now</button></div>${S.tsInput.trim() ? details(S.tsInput.trim()) : ''}`,
  onInput(el, ctx) {
    if (el.id === 'ts-input') { ctx.S.tsInput = el.value; ctx.changed(el); }
  },
  onClick(t, { S, recordSoon, rerender }) {
    if (t.id === 'ts-now') { S.tsInput = String(Math.floor(Date.now() / 1000)); recordSoon(); rerender(); }
  },
};
