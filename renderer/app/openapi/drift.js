// Spec drift: check every saved request of a project against its spec in one go (without sending),
// and list the spec operations no request covers. With responses (from the collection runner or the
// last send of each tab), the response check is included too.
import { allRequests, findReq } from '../store.js';
import { buildRequest } from '../http.js';
import { specAnalysis, validateExchange } from './registry.js';

// responses: { [requestId]: response } (optional)
// → { rows: [{ loc, op, request: [issues], response: [issues], error? }], uncovered: [{ spec, op }], counts }
export function driftCheck(p, responses = {}) {
  const rows = [];
  const covered = new Set();
  for (const r of allRequests(p)) {
    const loc = findReq(r.id);
    let wire;
    try { wire = buildRequest(loc); } catch (err) { rows.push({ loc, op: null, request: [], response: [], error: err.message }); continue; }
    const res = responses[r.id];
    const v = validateExchange(loc, wire, res && !res.error ? res : null);
    if (!v?.match) { rows.push({ loc, op: null, request: [], response: [] }); continue; }
    covered.add(`${v.match.meta.id} ${v.match.op.key}`);
    rows.push({ loc, op: v.match.op, spec: v.match.meta, linked: v.match.linked, request: v.request, response: v.response, missingVars: wire.missingVars });
  }
  const uncovered = [];
  for (const meta of p.specs || []) {
    for (const op of specAnalysis(meta.id)?.operations || []) if (!covered.has(`${meta.id} ${op.key}`)) uncovered.push({ spec: meta, op });
  }
  const errors = (row) => [...row.request, ...row.response].filter((i) => i.level === 'error').length;
  return {
    rows: rows.sort((x, y) => errors(y) - errors(x) || (x.op ? 0 : 1) - (y.op ? 0 : 1)),
    uncovered,
    counts: {
      requests: rows.length,
      failing: rows.filter((r) => errors(r) > 0).length,
      unmatched: rows.filter((r) => !r.op && !r.error).length,
      uncovered: uncovered.length,
    },
  };
}
