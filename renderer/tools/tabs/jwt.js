import { esc, copyText } from '../../shared/html.js';
import { highlightJson } from '../../shared/json.js';
import { decodeJwt } from '../lib/codec.js';
import { relTime } from '../lib/time.js';
import { PRE } from '../lib/ui.js';

const TIME_CLAIMS = [['exp', 'Expires'], ['nbf', 'Not before'], ['iat', 'Issued']];

// → { cls, text } for the token's validity right now (the signature is not checked).
export function jwtStatus(payload, now = Date.now()) {
  const exp = typeof payload?.exp === 'number' ? payload.exp * 1000 : null, nbf = typeof payload?.nbf === 'number' ? payload.nbf * 1000 : null;
  if (nbf && nbf > now) return { cls: 'warn', text: `Not valid yet: starts ${relTime(new Date(nbf), now)}` };
  if (exp && exp <= now) return { cls: 'bad', text: `Expired ${relTime(new Date(exp), now)}` };
  if (exp) return { cls: 'ok', text: `Valid: expires ${relTime(new Date(exp), now)}` };
  return { cls: 'warn', text: 'No expiry (exp) claim' };
}

export default {
  id: 'jwt', label: 'JWT',
  state: { jwtInput: '' },
  keys: ['jwtInput'],
  sensitive: true, // history keeps a short label only, never the token
  primary: (S) => S.jwtInput,
  receive(S, value) { S.jwtInput = value.replace(/^Bearer\s+/i, ''); },
  render(S) {
    const decoded = S.jwtInput.trim() ? decodeJwt(S.jwtInput.replace(/^Bearer\s+/i, '')) : null;
    let info = '';
    if (decoded) {
      const st = jwtStatus(decoded.payload);
      const times = TIME_CLAIMS.filter(([k]) => typeof decoded.payload[k] === 'number')
        .map(([k, label]) => { const d = new Date(decoded.payload[k] * 1000); return `<span class="hint">${label} (${k})</span><span>${esc(d.toLocaleString())} · ${esc(relTime(d))}</span>`; }).join('');
      const facts = [['Algorithm', decoded.header.alg], ['Type', decoded.header.typ], ['Key id', decoded.header.kid], ['Issuer', decoded.payload.iss], ['Subject', decoded.payload.sub], ['Audience', Array.isArray(decoded.payload.aud) ? decoded.payload.aud.join(', ') : decoded.payload.aud]]
        .filter(([, v]) => v != null && v !== '').map(([k, v]) => `<span class="hint">${k}</span><code>${esc(String(v))}</code>`).join('');
      info = `<p class="jwt-status jwt-${st.cls}">${esc(st.text)}</p>
        <div class="jwt-facts">${facts}${times}</div>
        <p class="hint">The signature isn't checked here.</p>
        <h4>Header</h4><pre style="${PRE}">${highlightJson(JSON.stringify(decoded.header, null, 2))}</pre>
        <h4 class="row items-center gap-6">Payload <button class="btn-ghost small" id="jwt-copy-payload">Copy</button></h4><pre style="${PRE}">${highlightJson(JSON.stringify(decoded.payload, null, 2))}</pre>`;
    }
    return `<textarea id="jwt-input" rows="4" placeholder="Paste a JWT (a leading “Bearer ” is fine)…" spellcheck="false">${esc(S.jwtInput)}</textarea>
      ${decoded ? info : S.jwtInput.trim() ? '<p class="error-text">Not a JWT: expected three base64url parts separated by dots, with JSON header and payload.</p>' : ''}`;
  },
  onInput(el, ctx) {
    if (el.id === 'jwt-input') { ctx.S.jwtInput = el.value; ctx.changed(el); }
  },
  onClick(t, { S }) {
    if (t.id === 'jwt-copy-payload') { const d = decodeJwt(S.jwtInput.replace(/^Bearer\s+/i, '')); if (d) copyText(JSON.stringify(d.payload, null, 2)); }
  },
};
