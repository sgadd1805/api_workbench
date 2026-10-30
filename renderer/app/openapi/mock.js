// Route table for the mock server (main/mock.js): every operation with a ready-made body per
// response code, taken from the spec's examples or generated from its schemas.
import { mediaExample, preferredMedia } from './generate.js';

const toBody = (value, contentType) => (value === undefined ? '' : typeof value === 'string' && !/json/i.test(contentType) ? value : JSON.stringify(value, null, 2));

// overrides: { 'GET /pets/{id}': '404' | 'drop' }
export function mockRoutes(analysis, overrides = {}) {
  const root = analysis.doc;
  return analysis.operations.map((op) => {
    const responses = {};
    for (const [code, r] of Object.entries(op.responses || {})) {
      const mt = preferredMedia(r.content);
      responses[code] = mt
        ? { contentType: mt, body: toBody(mediaExample(r.content[mt], root, true), mt) }
        : { contentType: null, body: null };
    }
    return { method: op.method, path: op.path, summary: op.summary || '', responses, ...(overrides[op.key] && { override: overrides[op.key] }) };
  });
}

// Base path the app's server URL uses ('/api/v1'), so the mock can be pointed at with the same paths.
export const mockBasePath = (analysis) => analysis.basePaths[0] || '';

// Status choices for an operation: its documented codes plus common failures.
export function statusChoices(op) {
  const documented = Object.keys(op.responses || {}).filter((c) => /^\d{3}$/.test(c));
  return [...new Set([...documented, '400', '401', '404', '429', '500', '503'])].sort();
}
