// Response-time trends: percentiles, the "slower than usual" flag, recording per environment, the views,
// and the main-process store (main/timings.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appended = [];
globalThis.window = { electronAPI: { storageSet() {}, timingsLoad: async () => stored, timingsAppend: (id, s) => appended.push([id, s]), timingsClear() {}, historyAppend() {} } };
let stored = {};
const { percentile, stats, slowness, recordTiming, samplesFor, loadTimings, clearTimings, MIN_BASELINE } = await import('../renderer/app/timings.js');
const { recordHistory } = await import('../renderer/app/history.js');
const { sparklineHtml, slowBadgeHtml, trendSectionHtml } = await import('../renderer/app/views/trend.js');
const { createTimingsStore, MAX_PER_REQUEST } = createRequire(import.meta.url)('../main/timings.js');

const runs = (list, status = 200) => list.map((ms, i) => ({ at: i, ms, status, env: 'e1' }));

test('percentiles and stats count successful runs only', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
  assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95), 95);
  const st = stats([...runs([100, 120, 110, 130, 90]), { at: 9, ms: 5, status: 500, env: 'e1' }]);
  assert.deepEqual(st, { n: 5, runs: 6, p50: 110, p95: 130, min: 90, max: 130, last: 5 });
});

test('slowness: needs enough runs, ignores small absolute changes, needs 2× the median and above p95', () => {
  const base = runs([100, 110, 120, 105, 115]);
  assert.equal(slowness(500, base.slice(0, MIN_BASELINE - 1)), null, 'too few runs');
  assert.deepEqual(slowness(330, base), { ratio: 3, p50: 110, p95: 120, n: 5 });
  assert.equal(slowness(200, base), null, 'under 2× the median');
  assert.equal(slowness(25, runs([8, 10, 12, 9, 11])), null, 'more than doubled but only 15 ms slower: noise');
  assert.equal(slowness(240, runs([100, 110, 120, 105, 250])), null, 'twice the median but not above the usual p95');
  assert.equal(slowness(1000, runs([100, 110, 120, 105, 115], 500)), null, 'failed runs are no baseline');
});

test('recording: per environment, errors and streams skipped, res.slow set before the run joins the baseline', async () => {
  stored = { old: [[1, 50, 200, 'e1']] };
  await loadTimings([{ reqId: 'h', at: 5, response: { time: 70, status: 200 } }, { reqId: 'h', at: 4, response: { time: 60, status: 200 } }, { reqId: 'old', at: 3, response: { time: 999, status: 200 } }]);
  assert.deepEqual(samplesFor('h', 'any').map((s) => s.ms), [60, 70], 'seeded from History, oldest first; unknown env counts for any');
  assert.deepEqual(samplesFor('old', 'e1').map((s) => s.ms), [50], 'stored samples win over History');
  const loc = (env = 'e1', kind) => ({ p: { activeEnv: env }, r: { id: 'r1', ...(kind && { kind }) } });
  for (const ms of [100, 110, 120, 105, 115]) assert.equal(recordTiming(loc(), { time: ms, status: 200 }), null);
  assert.equal(recordTiming(loc('e2'), { time: 400, status: 200 }), null, 'another environment has no baseline yet');
  const res = { time: 400, status: 200, body: '' };
  recordHistory({ p: { id: 'p', activeEnv: 'e1' }, r: { id: 'r1', name: 'R', method: 'GET', url: 'u' } }, res);
  assert.deepEqual(res.slow, { ratio: 3.6, p50: 110, p95: 120, n: 5 });
  assert.equal(recordTiming(loc(), { error: 'ECONNREFUSED' }), null);
  assert.equal(recordTiming(loc('e1', 'ws'), { time: 5, status: 101 }), null);
  assert.deepEqual(samplesFor('r1', 'e1').map((s) => s.ms), [100, 110, 120, 105, 115, 400]);
  assert.deepEqual(samplesFor('r1', 'e2').map((s) => s.ms), [400]);
  assert.equal(samplesFor('r1', 'e1', { allEnvs: true }).length, 7);
  assert.deepEqual(appended.at(-1)[1].slice(1), [400, 200, 'e1']);
  clearTimings('r1');
  assert.equal(samplesFor('r1', 'e1').length, 0);
});

test('views: sparkline, slow badge and History chart', async () => {
  stored = {};
  await loadTimings([]);
  const loc = { p: { activeEnv: 'e1' }, r: { id: 'v1' } };
  assert.equal(sparklineHtml('v1', 'e1'), '');
  assert.match(trendSectionHtml('v1', 'e1'), /appears after a few sends/);
  for (const ms of [100, 110, 120, 105, 115, 500]) recordTiming(loc, { time: ms, status: 200 });
  const spark = sparklineHtml('v1', 'e1', { ratio: 4.5 });
  assert.match(spark, /<polyline points="[\d., ]+"/);
  assert.match(spark, /class="trend-pt-slow"/);
  assert.match(spark, /p50 110 ms · p95 500 ms over 6 successful runs/);
  assert.equal(slowBadgeHtml(null), '');
  assert.match(slowBadgeHtml({ ratio: 4.5, p50: 110, p95: 120, n: 5 }), /▲ 4\.5× slower than usual/);
  assert.match(slowBadgeHtml({ ratio: 4.5, p50: 110, p95: 120, n: 5 }, { short: true }), />▲ 4\.5×<\/span>/);
  const chart = trendSectionHtml('v1', 'e1', { envName: 'local' });
  assert.equal((chart.match(/<circle /g) || []).length, 6);
  assert.equal((chart.match(/class="trend-pt-slow"/g) || []).length, 1, 'the 500 ms run is flagged against the five before it');
  for (const s of ['p50 110 ms', 'p95 500 ms', '▲ 1 slow run', 'data-action="trend-reset"', '>local<']) assert.ok(chart.includes(s), s);
});

test('main store: capped per request, batched to disk, reset keeps an empty list', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-')), 'timings.json');
  const store = createTimingsStore(file);
  for (let i = 0; i < MAX_PER_REQUEST + 20; i++) store.append('r', [i, i, 200, null]);
  assert.equal(store.append('r', [1, 'slow', 200]), false);
  assert.equal(store.append('', [1, 2, 200]), false);
  store.append('q', [1, 2, 200, 'e', 'extra']);
  store.flush();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.r.length, MAX_PER_REQUEST); assert.deepEqual(saved.r[0], [20, 20, 200, null]);
  assert.deepEqual(saved.q, [[1, 2, 200, 'e']]);
  store.clear('r'); store.flush();
  assert.deepEqual(createTimingsStore(file).all(), { r: [], q: [[1, 2, 200, 'e']] });
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(createTimingsStore(file).all(), {});
});
