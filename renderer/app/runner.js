// Collection runner: send a folder / project / feature group in order, optionally once per data row
// (CSV), checking assertions, script tests and the API spec, and report pass / fail.
import { DB, findReq, allRequests, project, feature, currentProject } from './store.js';
import { assertionFailures } from './assertions.js';

// RFC 4180-ish CSV → [{ column: value }] using the first row as headers.
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...data] = rows.filter((r) => r.some((x) => x.trim()));
  if (!head) return [];
  return data.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

// The runner page's scope choice ('project|id', 'folder|id', 'feature|id') → a scope for requestsInScope.
export const scopeOf = (key) => { const [type, id] = (key || '').split('|'); return { type, id, projectId: type === 'project' ? id : currentProject()?.id }; };

// The requests a run covers, in order. scope: { type: 'project' | 'folder' | 'feature', id, projectId }
export function requestsInScope(scope) {
  if (scope.type === 'feature') return (feature(scope.id)?.requestIds || []).map(findReq).filter(Boolean);
  const p = project(scope.projectId); if (!p) return [];
  if (scope.type === 'folder') { const f = p.folders.find((x) => x.id === scope.id); return f ? f.requests.map((r) => ({ p, f, r })) : []; }
  return allRequests(p).map((r) => findReq(r.id));
}

// Pass/fail for one exchange. → { passed, failures: [string] }
export function judge(loc, res) {
  const failures = [];
  if (res.error) failures.push(res.error);
  else {
    failures.push(...assertionFailures(res.assertionResults)); // evaluated in the sandbox (actions/core.js attachValidation)
    if (!(loc.r.assertions || []).some((a) => a.trim()) && !(res.scriptTests || []).length && res.status >= 400) failures.push(`HTTP ${res.status}`);
    for (const m of res.graphqlErrors || []) failures.push(`GraphQL: ${m}`);
    if (res.snapshotResult && !res.snapshotResult.matches) failures.push(`snapshot: ${res.snapshotResult.diffs.length} difference(s), e.g. ${res.snapshotResult.diffs[0].path}`);
  }
  for (const t of res.scriptTests || []) if (!t.ok) failures.push(`test failed: ${t.name}${t.error ? ` — ${t.error}` : ''}`);
  for (const i of [...(res.validation?.request || []), ...(res.validation?.response || [])]) if (i.level === 'error') failures.push(`spec: ${i.where} ${i.message}`);
  return { passed: failures.length === 0, failures };
}

// Runs the collection. send(loc, vars) → result (http.js send + validation). onResult is called per request.
// options: { iterations, rows, delayMs, stopOnFailure, shouldStop(),
//   beforeSend(loc, vars, { index, iteration }) → { action: 'send' | 'skip' | 'stop', loc?, vars? } (may wait: the
//   runner page pauses there at breakpoints; loc / vars replace the request and variables for this send) }
export async function runCollection(locs, send, { iterations = 1, rows = [], delayMs = 0, stopOnFailure = false, shouldStop = () => false, beforeSend = null }, onResult) {
  const results = [];
  const passes = rows.length ? rows.length : Math.max(1, iterations);
  const byName = new Map(locs.map((l, i) => [l.r.name, i]));
  outer: for (let it = 0; it < passes; it++) {
    const vars = rows[it] || {};
    for (let i = 0; i < locs.length && i >= 0;) {
      if (shouldStop()) break outer;
      let loc = locs[i], sendVars = vars;
      if (beforeSend) {
        const d = (await beforeSend(loc, vars, { index: i, iteration: it + 1 })) || {};
        if (d.action === 'stop' || shouldStop()) break outer;
        if (d.action === 'skip') {
          const result = { iteration: it + 1, data: vars, reqId: loc.r.id, name: loc.r.name, method: loc.r.method, url: loc.r.url, status: null, time: 0, error: null, skipped: true, passed: true, failures: [] };
          results.push(result); onResult?.(result, results);
          i++; continue;
        }
        if (d.loc) loc = d.loc;
        if (d.vars) sendVars = d.vars;
      }
      const t0 = Date.now();
      const res = await send(loc, sendVars);
      const verdict = judge(loc, res);
      const result = { iteration: it + 1, data: sendVars, ...(loc !== locs[i] && { edited: true }), reqId: loc.r.id, name: loc.r.name, method: res.requestData?.method || loc.r.method, url: res.requestData?.url || loc.r.url,
        status: res.status ?? null, time: res.time ?? Date.now() - t0, error: res.error || null, slow: res.slow || null, capturedDiff: res.capturedDiff || null, ...verdict };
      results.push(result);
      onResult?.(result, results);
      if (stopOnFailure && !verdict.passed) break outer;
      // A post-response script can choose the next request (by name), or end the iteration (null).
      if (res.next === null) break;
      if (typeof res.next === 'string' && byName.has(res.next)) i = byName.get(res.next); else i++;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

// skipped (breakpoint "Skip") only appears when some were.
export function summarize(results) {
  const skipped = results.filter((r) => r.skipped).length;
  const passed = results.filter((r) => r.passed && !r.skipped).length;
  return { total: results.length, passed, failed: results.length - passed - skipped, time: results.reduce((n, r) => n + (r.time || 0), 0), ...(skipped && { skipped }) };
}

const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// JUnit XML, for CI dashboards.
export function toJUnit(name, results) {
  const s = summarize(results);
  const cases = results.map((r) => `    <testcase classname="${xml(name)}${r.iteration > 1 ? ` #${r.iteration}` : ''}" name="${xml(`${r.method} ${r.name}`)}" time="${(r.time / 1000).toFixed(3)}">${r.skipped ? `
      <skipped message="skipped at a breakpoint"/>` : r.passed ? '' : `
      <failure message="${xml(r.failures[0])}">${xml(r.failures.join('\n'))}</failure>`}
    </testcase>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${s.total}" failures="${s.failed}" time="${(s.time / 1000).toFixed(3)}">\n  <testsuite name="${xml(name)}" tests="${s.total}" failures="${s.failed}"${s.skipped ? ` skipped="${s.skipped}"` : ''}>\n${cases}\n  </testsuite>\n</testsuites>\n`;
}

export const scopeLabel = (scope) => scope.type === 'feature' ? feature(scope.id)?.name : scope.type === 'folder' ? project(scope.projectId)?.folders.find((f) => f.id === scope.id)?.name : project(scope.projectId)?.name;
export { DB };

// The {{variables}} a request uses (URL, headers, body, auth), without dynamic ones ({{$uuid}} …), in order.
export function varsUsed(r) {
  const texts = [r.url, ...r.headers.flatMap((h) => [h.k, h.v]), r.body?.text, r.body?.file, ...(r.body?.form || []).flatMap((x) => [x.k, x.v]),
    r.auth?.token, r.auth?.user, r.auth?.pass, r.graphql?.query, r.graphql?.variables];
  const out = new Set();
  for (const t of texts) for (const m of String(t || '').matchAll(/\{\{\s*([^}$\s][^}]*?)\s*\}\}/g)) out.add(m[1]);
  return [...out];
}
