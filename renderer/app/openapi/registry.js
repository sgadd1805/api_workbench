// Spec documents attached to projects (metadata in Project.specs, documents stored by main/specs.js),
// cached here once loaded, and the lookup from a request to the operation it should be checked against.
import { analyzeSpec, matchOperation, pathParamsFor } from './spec.js';
import { validateRequest, validateResponse } from './validate.js';

const cache = new Map(); // spec id → analysis (see spec.js analyzeSpec)
const failed = new Map(); // spec id → error message

export const specAnalysis = (id) => cache.get(id) || null;
export const specLoadError = (id) => failed.get(id) || null;

export function cacheSpec(id, doc) { cache.set(id, analyzeSpec(doc)); failed.delete(id); return cache.get(id); }
export function forgetSpec(id) { cache.delete(id); failed.delete(id); }

// Loads every spec of the project that isn't cached yet. → true if anything new was loaded.
export async function ensureProjectSpecs(p) {
  const missing = (p?.specs || []).filter((s) => !cache.has(s.id) && !failed.has(s.id));
  await Promise.all(missing.map(async (s) => {
    const res = await window.electronAPI.specStoreLoad(s.id);
    if (res.ok) cacheSpec(s.id, res.doc); else failed.set(s.id, res.error);
  }));
  return missing.length > 0;
}

// The operation a request is checked against: the one it's linked to (r.spec, set when it was created
// from the spec or picked in the Spec tab), else the best method + URL match across the project's specs.
// → { meta, analysis, op, pathParams, linked } | null
export function operationFor(loc, method, url) {
  const specs = loc.p.specs || [];
  const link = loc.r.spec;
  if (link?.specId) {
    const analysis = specAnalysis(link.specId), meta = specs.find((s) => s.id === link.specId);
    const op = analysis?.byKey.get(link.opKey);
    if (op && meta) return { meta, analysis, op, pathParams: pathParamsFor(analysis, op, url), linked: true };
  }
  for (const meta of specs) {
    const analysis = specAnalysis(meta.id);
    const m = analysis && matchOperation(analysis, method, url);
    if (m) return { meta, analysis, op: m.op, pathParams: m.pathParams, linked: false };
  }
  return null;
}

// Request (and, given a response, response) issues for one exchange. → { match, request, response } | null
export function validateExchange(loc, wire, res) {
  if (!loc.p.specs?.length) return null;
  const match = operationFor(loc, wire.method, wire.url);
  if (!match) return { match: null, request: [], response: [] };
  return {
    match,
    request: validateRequest(match.analysis, match.op, wire, match.pathParams),
    response: res && !res.error ? validateResponse(match.analysis, match.op, res) : [],
  };
}
