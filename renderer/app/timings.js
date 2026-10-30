// Response-time trends per request: every send's time (stored by main/timings.js), percentiles over a
// request's usual runs, and the "slower than usual" flag. Runs are compared within one environment,
// since local and staging times have little to do with each other.
//
// Sample: { at, ms, status, env: environment id | null (unknown: seeded from History, counts for any) }

const MAX_PER_REQUEST = 300; // matches main/timings.js
export const MIN_BASELINE = 5;  // runs needed before a send can be called slow
export const MIN_SLOWER_MS = 100; // below this, a doubling is noise (5 ms → 12 ms)

const samples = new Map(); // request id → [Sample], oldest first

const fromRow = ([at, ms, status, env]) => ({ at, ms, status, env: env ?? null });

// Loads the stored samples; requests with none yet start from their runs in History (newest first).
export async function loadTimings(historyEntries = []) {
  samples.clear();
  const stored = (await window.electronAPI.timingsLoad?.()) || {};
  for (const [id, rows] of Object.entries(stored)) if (Array.isArray(rows)) samples.set(id, rows.map(fromRow));
  seedFromHistory(historyEntries);
}

export function seedFromHistory(historyEntries) {
  const seeded = new Map();
  for (const e of [...historyEntries].reverse()) {
    if (!e.reqId || samples.has(e.reqId) || !Number.isFinite(e.response?.time)) continue;
    if (!seeded.has(e.reqId)) seeded.set(e.reqId, []);
    seeded.get(e.reqId).push({ at: e.at, ms: e.response.time, status: e.response.status, env: null });
  }
  for (const [id, list] of seeded) samples.set(id, list.slice(-MAX_PER_REQUEST));
}

// A request's runs, oldest first: in environment envId (plus unknown-environment runs), or all of them.
export function samplesFor(reqId, envId, { allEnvs = false } = {}) {
  const list = samples.get(reqId) || [];
  return allEnvs ? list : list.filter((s) => s.env == null || s.env === (envId ?? null));
}

// Nearest-rank percentile of sorted numbers.
export const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : null);

// → { n (successful runs), runs (all), p50, p95, min, max, last } — percentiles over runs below 400,
// since errors are often much faster or slower than real answers.
export function stats(list) {
  const ok = list.filter((s) => s.status < 400 && Number.isFinite(s.ms)).map((s) => s.ms).sort((a, b) => a - b);
  return { n: ok.length, runs: list.length, p50: percentile(ok, 0.5), p95: percentile(ok, 0.95), min: ok[0] ?? null, max: ok.at(-1) ?? null, last: list.at(-1)?.ms ?? null };
}

// Is ms markedly slower than the baseline runs? → null | { ratio, p50, p95, n }
// Slow: at least twice the median, above the 95th percentile, and at least MIN_SLOWER_MS more.
export function slowness(ms, baseline) {
  if (!Number.isFinite(ms)) return null;
  const st = stats(baseline);
  if (st.n < MIN_BASELINE || !st.p50) return null;
  if (ms >= 2 * st.p50 && ms > st.p95 && ms - st.p50 >= MIN_SLOWER_MS) return { ratio: Math.round((ms / st.p50) * 10) / 10, p50: st.p50, p95: st.p95, n: st.n };
  return null;
}

const STREAMS = new Set(['ws', 'sse']); // connections, not request / response times

// Records a send's time and judges it against the request's earlier runs in the same environment.
// → the slowness verdict (null when not slow or not recorded)
export function recordTiming(loc, res, envId = loc?.p?.activeEnv ?? null) {
  if (!loc?.r || !res || res.error || res.cancelled || !Number.isFinite(res.time) || STREAMS.has(loc.r.kind)) return null;
  const slow = slowness(res.time, samplesFor(loc.r.id, envId));
  const sample = { at: Date.now(), ms: res.time, status: res.status, env: envId ?? null };
  const list = samples.get(loc.r.id) || [];
  list.push(sample);
  if (list.length > MAX_PER_REQUEST) list.splice(0, list.length - MAX_PER_REQUEST);
  samples.set(loc.r.id, list);
  window.electronAPI?.timingsAppend?.(loc.r.id, [sample.at, sample.ms, sample.status, sample.env]);
  return slow;
}

export function clearTimings(reqId) {
  samples.set(reqId, []); // stays empty: not seeded from History again
  window.electronAPI?.timingsClear?.(reqId);
}
