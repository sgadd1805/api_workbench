// Checks on a finished send that need more than the response itself: assertions (in the script sandbox),
// the request's saved snapshot, and the project's API specs. Used by every send in the app
// (actions/core.js) and by the command-line runner (cli/run.mjs), so it must not touch the UI.
import { capturedDiff } from './capture.js';
import { ensureProjectSpecs, validateExchange } from './openapi/registry.js';
import { compare as compareSnapshot } from './snapshot.js';
import { runAssertions } from './assertions.js';

// res.assertionResults: [{ expr, ok, err? }], res.snapshotResult (see snapshot.js),
// res.validation: { op: 'GET /path · title', request, response } | null.
export async function attachValidation(loc, res) {
  if (res && !res.error && !res.cancelled) res.assertionResults = await runAssertions(loc.r.assertions, res.status, res.body);
  if (loc.r.snapshot && res && !res.error && !res.cancelled) res.snapshotResult = compareSnapshot(loc.r.snapshot, res);
  if (loc.r.captured && res && !res.cancelled && !res.captured) res.capturedDiff = capturedDiff(loc.r.captured, res); // a captured request, sent again
  if (!loc.p.specs?.length || !res?.requestData || res.cancelled) return res;
  await ensureProjectSpecs(loc.p);
  const v = validateExchange(loc, res.requestData, res);
  res.validation = v && { op: v.match ? `${v.match.op.key} · ${v.match.meta.title}` : null, request: v.request, response: v.response };
  return res;
}
