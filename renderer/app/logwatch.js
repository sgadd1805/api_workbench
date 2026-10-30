// Log watch: flags log lines as they arrive (from tasks and log sources being followed) by level
// (ERROR / FATAL) and by the project's own patterns, counts them in the status bar, can notify, and
// tells a response which flagged lines appeared while it ran.
// Project.logWatch: { levels: true (flag ERROR / FATAL), patterns: 'text, /regex/i', notify: true }
const MAX_HITS = 1000;
const LATE_MS = 2000; // logs can arrive a moment after the response

// 'Timeout, /payment .* failed/i, OutOfMemory' → line → matched pattern | null
export function watchMatcher(watch = {}) {
  const tests = [];
  for (const raw of String(watch.patterns || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^\/(.+)\/([a-z]*)$/.exec(raw);
    if (m) { try { const re = new RegExp(m[1], m[2].replace(/g/g, '')); tests.push([raw, (t) => re.test(t)]); } catch { /* ignore a bad regex */ } }
    else tests.push([raw, (t) => t.toLowerCase().includes(raw.toLowerCase())]);
  }
  const levels = watch.levels !== false;
  return (line) => {
    if (line.cont) return null;
    if (levels && /^(ERROR|FATAL)$/.test(line.level)) return line.level;
    for (const [label, test] of tests) if (test(line.text)) return label;
    return null;
  };
}

export const hits = []; // newest last: { key, sourceId, sourceName, projectId, at, n, text, rule }
let seenUpTo = 0;       // hits before this index were seen (status bar count resets when looked at)

export function addHits(found) {
  hits.push(...found);
  if (hits.length > MAX_HITS) { const cut = hits.length - MAX_HITS; hits.splice(0, cut); seenUpTo = Math.max(0, seenUpTo - cut); }
}
export const unseenCount = (projectId) => hits.slice(seenUpTo).filter((h) => !projectId || h.projectId === projectId).length;
export const markSeen = () => { seenUpTo = hits.length; };
export const clearHits = () => { hits.length = 0; seenUpTo = 0; };
export const hitsFor = (projectId) => hits.filter((h) => h.projectId === projectId);

// Flagged lines of the project that arrived while a send ran (from its start until a moment after it finished).
export const hitsDuring = (projectId, from, to) => hits.filter((h) => h.projectId === projectId && h.at >= from && h.at <= to + LATE_MS);
export const LATE = LATE_MS;
