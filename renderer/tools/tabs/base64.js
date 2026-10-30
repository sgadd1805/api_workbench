import { esc } from '../../shared/html.js';
import { b64enc, b64dec } from '../lib/codec.js';
import { twoPanes } from '../lib/ui.js';

// base64url: "-" and "_" instead of "+" and "/", no "=" padding (JWTs, URLs, file names).
const toUrlSafe = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export default {
  id: 'base64', label: 'Base64',
  state: { b64Input: '', b64Decoded: '', b64UrlSafe: false, b64Error: '' },
  keys: ['b64Input', 'b64Decoded', 'b64UrlSafe'],
  sensitive: true, // often a token or key: history keeps a short label only
  primary: (S) => S.b64Input || S.b64Decoded,
  receive(S, value) { S.b64Decoded = value; try { S.b64Input = b64dec(value); S.b64Error = ''; } catch { S.b64Input = ''; S.b64Error = 'Not valid Base64'; } },
  render: (S) => `<label class="hint diff-opt mb-6"><input type="checkbox" id="b64-urlsafe" ${S.b64UrlSafe ? 'checked' : ''}/> URL-safe (base64url, no padding)</label>`
    + twoPanes(
      `<label class="hint">Plain text → encode</label><textarea id="b64-encode" rows="8" placeholder="Text to encode…" spellcheck="false">${esc(S.b64Input)}</textarea>`,
      `<label class="hint">Base64 → decode (either alphabet)</label><textarea id="b64-decode" rows="8" placeholder="Base64 to decode…" spellcheck="false">${esc(S.b64Decoded)}</textarea>${S.b64Error ? `<p class="error-text">${esc(S.b64Error)}</p>` : ''}`),
  onInput(el, { S, changed }) {
    if (el.id === 'b64-encode') { S.b64Input = el.value; S.b64Error = ''; try { const e = b64enc(el.value); S.b64Decoded = S.b64UrlSafe ? toUrlSafe(e) : e; } catch {} }
    else if (el.id === 'b64-decode') { S.b64Decoded = el.value; try { S.b64Input = b64dec(el.value); S.b64Error = ''; } catch { S.b64Error = el.value.trim() ? 'Not valid Base64' : ''; } }
    else return;
    changed(el);
  },
  onChange(el, { S, rerender }) {
    if (el.id !== 'b64-urlsafe') return;
    S.b64UrlSafe = el.checked;
    if (S.b64Input) { const e = b64enc(S.b64Input); S.b64Decoded = S.b64UrlSafe ? toUrlSafe(e) : e; }
    rerender();
  },
};
