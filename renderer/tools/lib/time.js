// "3 minutes ago" / "in 2 days".
export function relTime(d, now = Date.now()) {
  const s = Math.round((d.getTime() - now) / 1000), a = Math.abs(s);
  const [n, unit] = a < 60 ? [a, 'second'] : a < 3600 ? [Math.round(a / 60), 'minute'] : a < 86400 ? [Math.round(a / 3600), 'hour'] : [Math.round(a / 86400), 'day'];
  const label = `${n} ${unit}${n !== 1 ? 's' : ''}`;
  return s < 0 ? `${label} ago` : `in ${label}`;
}

// Unix seconds (≤ 1e10) or milliseconds, or anything Date can parse → Date (possibly invalid).
export function parseTimestamp(v) {
  if (/^\d+$/.test(v)) { const n = parseInt(v, 10); return new Date(n > 1e10 ? n : n * 1000); }
  return new Date(v);
}

export const fmtClock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
