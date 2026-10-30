'use strict';
// Load test: send one request N times (or for a duration) at a given concurrency through the same
// transport as normal sends, and report latency percentiles, throughput and status codes.
const { proxyFetch } = require('./http');
const { windows, alive } = require('./windows');

const runs = new Map(); // run id → { stop: boolean }

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

// Latency stats from samples [{ ms, status, error, at }]. Also a per-second timeline and a histogram.
function summarize(samples, wallMs) {
  const ok = samples.filter((s) => !s.error);
  const lat = ok.map((s) => s.ms).sort((a, b) => a - b);
  const statuses = {}, errors = {};
  for (const s of samples) { if (s.error) errors[s.error] = (errors[s.error] || 0) + 1; else statuses[s.status] = (statuses[s.status] || 0) + 1; }
  const round = (n) => Math.round(n * 10) / 10;
  const start = samples.length ? Math.min(...samples.map((s) => s.at)) : 0;
  const timeline = [];
  for (const s of samples) {
    const sec = Math.floor((s.at - start) / 1000);
    timeline[sec] ||= { second: sec, count: 0, totalMs: 0, errors: 0 };
    timeline[sec].count++; if (s.error || s.status >= 500) timeline[sec].errors++; else timeline[sec].totalMs += s.ms;
  }
  const buckets = 20, max = lat.at(-1) || 0, width = max / buckets || 1;
  const histogram = Array.from({ length: buckets }, (_, i) => ({ from: round(i * width), to: round((i + 1) * width), count: 0 }));
  for (const ms of lat) histogram[Math.min(buckets - 1, Math.floor(ms / width))].count++;
  return {
    count: samples.length, ok: ok.filter((s) => s.status < 400).length, failed: samples.length - ok.filter((s) => s.status < 400).length,
    rps: wallMs ? round(samples.length / (wallMs / 1000)) : 0, wallMs: Math.round(wallMs),
    min: round(lat[0] || 0), max: round(max), mean: round(lat.reduce((a, b) => a + b, 0) / (lat.length || 1)),
    p50: round(percentile(lat, 50)), p90: round(percentile(lat, 90)), p95: round(percentile(lat, 95)), p99: round(percentile(lat, 99)),
    statuses, errors, timeline: timeline.filter(Boolean).map((t) => ({ ...t, avgMs: t.count - t.errors ? round(t.totalMs / (t.count - t.errors)) : 0 })), histogram,
  };
}

// opts: { id, request: { url, method, headers, body, network, timeoutMs }, total, concurrency, durationSec }
async function run({ id, request, total = 100, concurrency = 10, durationSec = 0 }, onProgress = () => {}) {
  const state = { stop: false };
  runs.set(id, state);
  const samples = [];
  const t0 = performance.now();
  const deadline = durationSec > 0 ? t0 + durationSec * 1000 : Infinity;
  let issued = 0;
  const more = () => !state.stop && (durationSec > 0 ? performance.now() < deadline : issued < total);
  let lastReport = 0;
  const report = (final) => {
    const now = performance.now();
    if (!final && now - lastReport < 250) return;
    lastReport = now;
    onProgress({ id, done: samples.length, target: durationSec > 0 ? null : total, final, stats: summarize(samples, now - t0) });
  };
  const worker = async () => {
    while (more()) {
      issued++;
      const start = performance.now();
      const res = await proxyFetch({ ...request, body: request.body || undefined, redirect: 'follow' });
      samples.push({ ms: performance.now() - start, status: res.status, error: res.ok ? null : res.error, at: Date.now() });
      report(false);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 500)) }, worker));
  runs.delete(id);
  const stats = summarize(samples, performance.now() - t0);
  onProgress({ id, done: samples.length, final: true, stopped: state.stop, stats });
  return stats;
}

function register(ipcMain) {
  ipcMain.handle('load-run', (_e, opts) => run(opts, (p) => alive(windows.main)?.webContents.send('load-progress', p)));
  ipcMain.handle('load-stop', (_e, id) => { const s = runs.get(id); if (s) s.stop = true; return true; });
}

module.exports = { run, summarize, percentile, register };
