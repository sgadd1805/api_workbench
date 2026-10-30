// Assertions are user-written JS expressions over `status` and `body` (parsed JSON when possible).
// They are evaluated in the script sandbox (scripts.js runAssertions), never in the app's own window,
// because they can come from shared or imported files. A finished send carries the results as
// res.assertionResults: [{ expr, ok, err? }].
export { runAssertions } from './scripts.js';

export const assertionFailures = (results) => (results || []).filter((a) => !a.ok).map((a) => `assertion failed: ${a.expr}${a.err ? ` (${a.err})` : ''}`);
