// Token sources: named requests that fetch an access token (e.g. an OAuth2 client-credentials call),
// used by the "token source" auth type. Tokens are kept in memory only, per source + project +
// environment (the source's {{variables}} come from the requesting project's active environment),
// and re-fetched when they expire.
//
// TokenSource (DB.tokenSources): { id, name, method, url, headers: [Row], body: { type, text, form }, tokenPath }
import { DB, uid, normalizeRequest, activeEnv } from './store.js';
import { activeVars, resolve } from './vars.js';

const EXPIRY_MARGIN_MS = 30_000; // refresh a little before the server would reject the token
const cache = new Map();          // `${sourceId}|${projectId}|${envId}` → { token, expiresAt, fetchedAt }

export const tokenSource = (id) => DB.tokenSources.find((t) => t.id === id) || null;

export function newTokenSource(fields = {}) {
  const r = normalizeRequest({ method: 'POST', url: '', headers: [], body: { type: 'raw', text: '' }, ...fields });
  return { id: uid(), name: fields.name || 'New token source', method: r.method, url: r.url, headers: r.headers, body: r.body, tokenPath: fields.tokenPath || 'access_token' };
}

const keyFor = (sourceId, p) => `${sourceId}|${p?.id ?? ''}|${p?.activeEnv ?? ''}`;

// The cached token if it is still fresh, else null (sync, for cURL export and the auth hint).
export function cachedToken(sourceId, p, now = Date.now()) {
  const hit = cache.get(keyFor(sourceId, p));
  return hit && (!hit.expiresAt || hit.expiresAt - EXPIRY_MARGIN_MS > now) ? hit : null;
}
// Every cached token, so "Ask Claude" can remove them from its prompt (main/claude.js).
export const cachedTokenValues = () => [...cache.values()].map((e) => e.token).filter((t) => typeof t === 'string' && t);
export const forgetTokens = (sourceId) => { for (const k of cache.keys()) if (!sourceId || k.startsWith(sourceId + '|')) cache.delete(k); };

const pathGet = (obj, path) => path.replace(/^body\./, '').split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);

// A JWT's payload, or null when the token isn't a JWT.
export function jwtPayload(token) {
  try {
    const part = String(token).split('.');
    if (part.length !== 3) return null;
    const json = new TextDecoder().decode(Uint8Array.from(atob(part[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch { return null; }
}

// JWT `exp` (seconds) → ms, when the token is a JWT.
export function jwtExpiry(token) {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : null;
}

// The bearer token in a header set (case-insensitive), if any.
export function bearerOf(headers) {
  const v = Object.entries(headers || {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  const m = v && /^Bearer\s+(\S+)/i.exec(v);
  return m && !m[1].startsWith('<') ? m[1] : null;
}

// What the token inspector shows: { token, jwt: payload | null, expiresAt, expired, expiresInMs }.
export function inspectToken(token, now = Date.now()) {
  const jwt = jwtPayload(token);
  const expiresAt = typeof jwt?.exp === 'number' ? jwt.exp * 1000 : null;
  return { token, jwt, expiresAt, expired: !!expiresAt && expiresAt <= now, expiresInMs: expiresAt ? expiresAt - now : null };
}

// The wire request for a source, with variables from the project's active environment.
export function buildSourceRequest(src, p) {
  const vars = activeVars(p);
  const sub = (s) => resolve(s, vars);
  const headers = {};
  for (const h of src.headers) if (h.on && h.k) headers[sub(h.k)] = sub(h.v);
  let body = '';
  if (src.body.type === 'form') body = src.body.form.filter((r) => r.on && r.k).map((r) => encodeURIComponent(sub(r.k)) + '=' + encodeURIComponent(sub(r.v))).join('&');
  else if (src.body.type !== 'none') body = sub(src.body.text);
  const has = (k) => Object.keys(headers).some((x) => x.toLowerCase() === k);
  if (body && !has('content-type')) headers['Content-Type'] = src.body.type === 'json' ? 'application/json' : 'application/x-www-form-urlencoded';
  return { method: src.method, url: sub(src.url), headers, body, network: activeEnv(p)?.network || null };
}

// Response → { token, expiresAt } using the source's token path (+ expires_in or the JWT's exp).
export function extractToken(src, res, now = Date.now()) {
  let json; try { json = JSON.parse(res.body); } catch { throw new Error(`Token source "${src.name}" did not return JSON (HTTP ${res.status})`); }
  const token = pathGet(json, src.tokenPath || 'access_token');
  if (typeof token !== 'string' || !token) throw new Error(`No "${src.tokenPath}" in the response of token source "${src.name}" (HTTP ${res.status})`);
  const expiresIn = Number(json.expires_in ?? json.expiresIn);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : jwtExpiry(token);
  return { token, expiresAt: expiresAt || null };
}

// Fetches (or reuses) the token for a source. → { token, expiresAt, fetchedAt }; throws with a readable message.
export async function getToken(sourceId, p, { force = false } = {}) {
  const src = tokenSource(sourceId);
  if (!src) throw new Error('The token source used by this request no longer exists');
  if (!force) { const hit = cachedToken(sourceId, p); if (hit) return hit; }
  const wire = buildSourceRequest(src, p);
  const res = await window.electronAPI.doFetch({ ...wire, body: wire.body || undefined, timeoutMs: 30000 });
  if (!res.ok) throw new Error(`Token source "${src.name}": ${res.error}`);
  if (res.status >= 400) throw new Error(`Token source "${src.name}" failed: HTTP ${res.status} ${res.statusText}${res.body ? ' — ' + res.body.slice(0, 200) : ''}`);
  const entry = { ...extractToken(src, res), fetchedAt: Date.now() };
  cache.set(keyFor(sourceId, p), entry);
  return entry;
}

// ---- importing a source from a file
// Accepts a bare request object — { method, url, headers: [{ key, value, enabled }], body, body_type, token_path? } —
// or any export that contains requests (this app's collection export, a full data export, …): the
// first object with a method and URL is used.
export function tokenSourceFromFile(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Not a JSON file'); }
  const found = findRequest(data);
  if (!found) throw new Error('No request (an object with "method" and "url") found in the file');
  const headers = (Array.isArray(found.headers) ? found.headers : []).map((h) => ({
    k: h.key ?? h.k ?? h.name ?? '', v: String(h.value ?? h.v ?? ''), on: h.enabled ?? h.on ?? !h.disabled,
  }));
  const body = typeof found.body === 'object' && found.body
    ? { type: found.body.type || 'raw', text: found.body.text ?? found.body.raw ?? '', form: found.body.form || [] }
    : { type: found.body_type || found.bodyType || (found.body ? 'raw' : 'none'), text: found.body || '', form: [] };
  return newTokenSource({
    name: found.name || `${String(found.method).toUpperCase()} ${found.url}`.slice(0, 60),
    method: String(found.method).toUpperCase(), url: found.url, headers, body,
    tokenPath: found.token_path || found.tokenPath || 'access_token',
  });
}

function findRequest(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  if (!Array.isArray(node) && typeof node.method === 'string' && typeof node.url === 'string') return node;
  for (const v of Array.isArray(node) ? node : Object.values(node)) { const hit = findRequest(v, depth + 1); if (hit) return hit; }
  return null;
}
