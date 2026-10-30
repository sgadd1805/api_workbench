// Snapshot tests: a request's saved "expected" response (r.snapshot), compared with each new one field by
// field, ignoring volatile fields (ids, timestamps …).
// r.snapshot: { status, body, savedAt, ignore: [rule] }
//   rule: a field name anywhere ("createdAt"), or a path: "$.items[*].id", "$..traceId", "$.meta" (and all below it)
// compare() → { matches, diffs: [{ path, kind: 'status' | 'changed' | 'added' | 'removed' | 'text', expected, actual }], ignored }

const SIMPLE_KEY = /^[A-Za-z_$][\w$]*$/;
const keyPath = (path, k) => (SIMPLE_KEY.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`);

// Leaf values by path: { '$.items[0].id': 7, '$.tags': '[]' (empty containers) }
export function flatten(value, path = '$', out = new Map()) {
  if (Array.isArray(value)) { if (!value.length) out.set(path, '[]'); value.forEach((v, i) => flatten(v, `${path}[${i}]`, out)); }
  else if (value && typeof value === 'object') { const keys = Object.keys(value); if (!keys.length) out.set(path, '{}'); for (const k of keys) flatten(value[k], keyPath(path, k), out); }
  else out.set(path, value);
  return out;
}

const lastKey = (path) => /(?:\.([A-Za-z_$][\w$]*)|\["((?:[^"\\]|\\.)*)"\])$/.exec(path)?.slice(1).find((x) => x !== undefined);

// A rule → test(path). Paths below a matched path match too ("$.meta" ignores $.meta.when).
export function ruleMatcher(rule) {
  const r = String(rule).trim();
  if (!r) return () => false;
  if (!r.startsWith('$')) return (path) => path.split(/(?=\.|\[)/).some((seg) => seg === `.${r}` || seg === `[${JSON.stringify(r)}]`);
  let re = '';
  for (let i = 1; i < r.length;) {
    if (r.startsWith('..', i)) { re += '(?:\\.[^.\\[]+|\\[[^\\]]+\\])*'; i += 1; continue; }
    if (r.startsWith('[*]', i)) { re += '\\[\\d+\\]'; i += 3; continue; }
    if (r.startsWith('.*', i)) { re += '\\.[^.\\[]+'; i += 2; continue; }
    re += r[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i++;
  }
  const rx = new RegExp(`^\\$${re}(?=$|[.\\[])`);
  return (path) => rx.test(path);
}

const parse = (text) => { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; } };
const show = (v) => (v === undefined ? '(missing)' : typeof v === 'string' ? JSON.stringify(v) : String(v));

export function compare(snapshot, res) {
  const rules = (snapshot.ignore || []).map(ruleMatcher);
  const ignored = (path) => rules.some((m) => m(path));
  const diffs = [];
  let ignoredCount = 0;
  if (snapshot.status !== res.status) diffs.push({ path: 'status', kind: 'status', expected: String(snapshot.status), actual: String(res.status) });
  const a = parse(snapshot.body), b = parse(res.body ?? '');
  if (a.ok && b.ok) {
    const fa = flatten(a.value), fb = flatten(b.value);
    for (const [path, v] of fa) {
      if (ignored(path)) { ignoredCount++; continue; }
      if (!fb.has(path)) diffs.push({ path, kind: 'removed', expected: show(v), actual: '(missing)' });
      else if (fb.get(path) !== v) diffs.push({ path, kind: 'changed', expected: show(v), actual: show(fb.get(path)) });
    }
    for (const [path, v] of fb) if (!fa.has(path) && !ignored(path)) diffs.push({ path, kind: 'added', expected: '(missing)', actual: show(v) });
  } else if ((snapshot.body ?? '') !== (res.body ?? '')) {
    diffs.push({ path: 'body', kind: 'text', expected: `${(snapshot.body || '').length} characters`, actual: `${(res.body || '').length} characters` });
  }
  return { matches: diffs.length === 0, diffs, ignored: ignoredCount };
}

// A rule that ignores just this field, and one for this field name anywhere.
export function ignoreRulesFor(path) {
  const exact = path.replace(/\[\d+\]/g, '[*]');
  const key = lastKey(path);
  return { exact, key: key && SIMPLE_KEY.test(key) ? key : null };
}

export const makeSnapshot = (res, ignore = []) => ({ status: res.status, body: res.body ?? '', savedAt: Date.now(), ignore });
