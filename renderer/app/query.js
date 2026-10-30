// The Params tab edits the URL's query string as rows. This works on the raw text (not URL()),
// because the URL may contain {{variables}} that aren't valid until resolved.
import { encodeKeepingVars } from './vars.js';

export function splitUrl(url) {
  const hashAt = url.indexOf('#');
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const rest = hashAt < 0 ? url : url.slice(0, hashAt);
  const qAt = rest.indexOf('?');
  return qAt < 0 ? { base: rest, query: '', hash } : { base: rest.slice(0, qAt), query: rest.slice(qAt + 1), hash };
}

const decode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };

// 'a=1&b' → [{k:'a', v:'1'}, {k:'b', v:''}]
export function parseQuery(query) {
  return query.split('&').filter(Boolean).map((pair) => {
    const ix = pair.indexOf('=');
    return ix < 0 ? { k: decode(pair), v: '' } : { k: decode(pair.slice(0, ix)), v: decode(pair.slice(ix + 1)) };
  });
}

export function buildQuery(rows) {
  return rows.filter((r) => r.k).map((r) => encodeKeepingVars(r.k) + (r.v === '' ? '' : '=' + encodeKeepingVars(r.v))).join('&');
}

export const queryRows = (url) => parseQuery(splitUrl(url).query);

export function withQuery(url, rows) {
  const { base, hash } = splitUrl(url);
  const q = buildQuery(rows);
  return base + (q ? '?' + q : '') + hash;
}
