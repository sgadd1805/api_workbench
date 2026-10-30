import { esc, copyText } from '../../shared/html.js';
import { md5 } from '../lib/md5.js';

const ALGOS = ['MD5', 'SHA-1', 'SHA-256', 'SHA-512'];
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

// Digest, or HMAC when a key is given (not for MD5). → { hex, base64 }
export async function digest(algo, input, key = '') {
  if (algo === 'MD5') { const h = md5(input); return { hex: h, base64: btoa(h.match(/../g).map((x) => String.fromCharCode(parseInt(x, 16))).join('')) }; }
  const data = new TextEncoder().encode(input);
  const buf = key
    ? await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: algo }, false, ['sign']), data)
    : await crypto.subtle.digest(algo, data);
  return { hex: hex(buf), base64: b64(buf) };
}

// Digests are async (Web Crypto); hashSeq drops results that a newer input has superseded.
let hashSeq = 0;
async function computeHash(S) {
  const seq = ++hashSeq;
  const out = S.hashInput ? await digest(S.hashAlgo, S.hashInput, S.hashAlgo === 'MD5' ? '' : S.hashKey) : { hex: '', base64: '' };
  if (seq !== hashSeq) return;
  S.hashOutput = out.hex; S.hashOutputB64 = out.base64;
  // Update just the outputs so the textarea keeps focus and cursor.
  for (const [id, v] of [['hash-output', out.hex], ['hash-output-b64', out.base64]]) { const el = document.getElementById(id); if (el) el.textContent = v; }
}

const outRow = (id, label, value) => `<div style="margin-top:8px"><label class="hint">${label}</label><div style="display:flex;gap:8px;align-items:center;margin-top:4px">
  <code id="${id}" style="flex:1;background:var(--input-bg);border:1px solid var(--border);border-radius:4px;padding:8px 10px;font-size:13px;word-break:break-all;min-height:36px;display:block">${esc(value)}</code>
  <button class="btn-ghost small" data-copy-from="${id}">Copy</button></div></div>`;

export default {
  id: 'hash', label: 'Hash',
  state: { hashInput: '', hashAlgo: 'SHA-256', hashKey: '', hashOutput: '', hashOutputB64: '' },
  keys: ['hashInput', 'hashAlgo'], // never the HMAC key
  sensitive: true, // often a token or key: history keeps a short label only
  primary: (S) => S.hashInput,
  receive(S, value) { S.hashInput = value; computeHash(S); },
  render: (S) => `<div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">${ALGOS.map((a) =>
      `<label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer"><input type="radio" name="hash-algo" value="${a}" ${S.hashAlgo === a ? 'checked' : ''}/>${a}</label>`).join('')}</div>
    <textarea id="hash-input" rows="5" placeholder="Input text…" spellcheck="false">${esc(S.hashInput)}</textarea>
    <div class="row gap-6 items-center mt-6"><label class="hint" for="hash-key" style="white-space:nowrap">HMAC key</label>
      <input id="hash-key" type="password" autocomplete="off" placeholder="${S.hashAlgo === 'MD5' ? 'Not for MD5' : 'Optional: sign with HMAC-' + S.hashAlgo}" value="${esc(S.hashKey)}" ${S.hashAlgo === 'MD5' ? 'disabled' : ''} class="grow"/></div>
    ${outRow('hash-output', `${S.hashKey && S.hashAlgo !== 'MD5' ? 'HMAC' : 'Digest'} (hex)`, S.hashOutput)}${outRow('hash-output-b64', 'Base64', S.hashOutputB64)}`,
  onRestore({ S }) { S.hashOutput = ''; S.hashOutputB64 = ''; computeHash(S); },
  onInput(el, { S, recordSoon }) {
    if (el.id === 'hash-input') { S.hashInput = el.value; recordSoon(); computeHash(S); }
    else if (el.id === 'hash-key') { S.hashKey = el.value; computeHash(S); }
  },
  onChange(el, { S, rerender }) {
    if (el.name === 'hash-algo') { S.hashAlgo = el.value; rerender(); computeHash(S); }
  },
  onClick(t) {
    const c = t.closest('[data-copy-from]'); if (c) copyText(document.getElementById(c.dataset.copyFrom)?.textContent || '');
  },
};
