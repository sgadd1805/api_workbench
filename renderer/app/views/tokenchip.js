// Token inspector: one line under the URL bar describing the bearer token this request would send.
import { esc } from '../../shared/html.js';
import { findReq, effectiveAuth } from '../store.js';
import { buildRequest } from '../http.js';
import { bearerOf, inspectToken, tokenSource, cachedToken } from '../tokens.js';

const human = (ms) => {
  const s = Math.abs(ms) / 1000;
  return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

export function tokenChipHtml(r) {
  const loc = findReq(r.id); if (!loc) return '';
  const auth = effectiveAuth(loc);
  let wire; try { wire = buildRequest(loc); } catch { return ''; }
  const token = bearerOf(wire.headers);
  if (auth.type === 'token' && !token) {
    const src = tokenSource(auth.sourceId);
    return `<div class="token-chip"><span>🔑</span> ${src ? `Token from <b>${esc(src.name)}</b> — fetched when you send` : '<span class="assert-fail">token source missing</span>'}
      ${src ? '<button class="link-btn" data-action="token-refresh">Fetch now</button>' : ''}</div>`;
  }
  if (!token) return '';
  const info = inspectToken(token);
  const from = auth.type === 'token' ? `from ${esc(tokenSource(auth.sourceId)?.name || 'token source')}` : 'Bearer';
  if (!info.jwt) return `<div class="token-chip"><span>🔑</span> ${from} token <code>${esc(token.slice(0, 10))}…</code> <span class="hint">(not a JWT)</span></div>`;
  const who = info.jwt.sub || info.jwt.preferred_username || info.jwt.client_id || info.jwt.email || '';
  const state = !info.expiresAt ? '<span class="hint">no expiry</span>'
    : info.expired ? `<span class="assert-fail">expired ${human(info.expiresInMs)} ago</span>`
      : `<span class="${info.expiresInMs < 300000 ? 'warn-text' : 'assert-pass'}">expires in ${human(info.expiresInMs)}</span>`;
  const cached = auth.type === 'token' ? cachedToken(auth.sourceId, loc.p) : null;
  return `<div class="token-chip${info.expired ? ' expired' : ''}" title="${esc(JSON.stringify(info.jwt, null, 2).slice(0, 1500))}">
    <span>🔑</span> JWT ${from}${who ? ` · <b>${esc(who)}</b>` : ''}${info.jwt.iss ? ` <span class="hint">· ${esc(String(info.jwt.iss).replace(/^https?:\/\//, '').slice(0, 40))}</span>` : ''} · ${state}
    ${cached ? `<span class="hint">· fetched ${esc(new Date(cached.fetchedAt).toLocaleTimeString())}</span>` : ''}
    <button class="link-btn" data-action="token-inspect">Inspect</button>
    ${info.expired || auth.type === 'token' ? `<button class="link-btn" data-action="token-refresh">${auth.type === 'token' ? 'Refresh' : 'Refresh via login session'}</button>` : ''}</div>`;
}
