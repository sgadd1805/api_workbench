// Git history state per request (kept for the session), and the default search terms for a request.
import { urlPath } from './openapi/spec.js';

const states = new Map(); // request id → { terms, loading, error, result, selected, diff, diffLoading }

export function gitState(reqId) {
  if (!states.has(reqId)) states.set(reqId, { terms: [], loading: false, error: null, result: null, selected: null, diff: null, diffLoading: false });
  return states.get(reqId);
}
export const resetGit = (reqId) => states.delete(reqId);

const looksLikeId = (seg) => /^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || /^\{\{.*\}\}$/.test(seg) || seg.length > 40;

// What to look for in the code: the spec's path template and operationId (how controllers usually
// spell the route), else the request URL's path minus the server base and id-like segments.
export function defaultTerms({ op, basePath = '', url }) {
  if (op) return [...new Set([op.path, op.operationId].filter((t) => t && t.length >= 3))];
  let path = urlPath(url || '');
  if (basePath && path.startsWith(basePath)) path = path.slice(basePath.length);
  const segs = path.split('/').filter(Boolean);
  const literal = [];
  for (const s of segs) { if (looksLikeId(s)) break; literal.push(s); }
  const term = '/' + literal.join('/');
  return term.length >= 4 ? [term] : [];
}

// Repository panel state per code folder: { loading, error, status (main/git.js repoStatus), busy, showRemote }
const repos = new Map();
export function repoState(folder) {
  if (!repos.has(folder)) repos.set(folder, { loading: false, error: null, status: null, busy: '', showRemote: false });
  return repos.get(folder);
}
