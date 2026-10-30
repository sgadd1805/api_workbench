// The diff engine (renderer/shared/diff.js) and the Tools window's helpers built on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {};
const { lineDiff, diffStats, collapse, diffHtml, sideBySideHtml, unifiedPatch, sortedJson, jsonChanges } = await import('../renderer/shared/diff.js');

// Length of a longest common subsequence, the size of the "same" part any minimal diff must have.
function lcs(x, y) {
  const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) dp[i][j] = x[i - 1] === y[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[x.length][y.length];
}

test('lineDiff is minimal and rebuilds both sides, with line numbers', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let t = 0; t < 400; t++) {
    const gen = () => Array.from({ length: Math.floor(rnd() * 14) }, () => 'abcd'[Math.floor(rnd() * 4)]).join('\n');
    const a = gen(), b = gen(), rows = lineDiff(a, b, { words: false });
    assert.equal(rows.filter((r) => r.type !== 'add').map((r) => r.text).join('\n'), a);
    assert.equal(rows.filter((r) => r.type !== 'del').map((r) => r.text).join('\n'), b);
    assert.equal(rows.filter((r) => r.type === 'same').length, lcs(a.split('\n'), b.split('\n')));
    assert.deepEqual(rows.filter((r) => r.a).map((r) => r.a), a.split('\n').map((_, i) => i + 1));
    assert.deepEqual(rows.filter((r) => r.b).map((r) => r.b), b.split('\n').map((_, i) => i + 1));
  }
});

test('ignore whitespace, case and Windows line endings', () => {
  assert.ok(diffStats(lineDiff('  a  b\nC', 'a b \nc', { ignoreWhitespace: true, ignoreCase: true })).identical);
  assert.equal(diffStats(lineDiff('a\nb', 'A\nb')).hunks, 1);
  assert.ok(diffStats(lineDiff('a\r\nb\r\n', 'a\nb\n')).identical, 'CRLF vs LF is not a change');
});

test('changed words are marked inside similar lines only', () => {
  const [, del, add] = lineDiff('x\n  "price": 10,\ny', 'x\n  "price": 12,\ny');
  assert.deepEqual(del.words.filter((w) => w.changed).map((w) => w.text), ['10']);
  assert.deepEqual(add.words.filter((w) => w.changed).map((w) => w.text), ['12']);
  assert.match(diffHtml([add]), /<span class="diff-word">12<\/span>/);
  const [d2] = lineDiff('completely different words here', 'nothing alike at all, really');
  assert.equal(d2.words, undefined);
});

test('stats, folding unchanged lines, and jump targets', () => {
  const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
  const rows = lineDiff(a, a.replace('l5', 'L5').replace('l25', 'L25'));
  assert.deepEqual(diffStats(rows), { added: 2, removed: 2, hunks: 2, identical: false });
  const segs = collapse(rows, 3);
  // 3 lines of context, the removed and added line, 3 more; 2 lines before and 13 between fold; a single last line doesn't.
  assert.deepEqual(segs.map((s) => [s.kind, s.to - s.from]), [['gap', 2], ['rows', 8], ['gap', 13], ['rows', 8], ['rows', 1]]);
  const html = diffHtml(rows, { context: 3, numbers: true });
  assert.equal((html.match(/data-gap=/g) || []).length, 2);
  assert.equal((html.match(/data-hunk=/g) || []).length, 2);
  const open = diffHtml(rows, { context: 3, expanded: new Set([segs[2].id]) });
  assert.equal((open.match(/data-gap=/g) || []).length, 1);
  assert.match(html, /<span class="diff-ln">6<\/span><span class="diff-ln"><\/span><span class="diff-sign">-<\/span>/);
  const side = sideBySideHtml(rows);
  assert.equal((side.match(/<tr data-hunk/g) || []).length, 2);
  assert.equal((side.match(/<tr/g) || []).length, 30, 'a removed and an added line share a row');
});

test('unifiedPatch is a valid diff -u', () => {
  const rows = lineDiff('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten', 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven');
  assert.equal(unifiedPatch(rows, { aName: 'a/x', bName: 'b/x' }), [
    '--- a/x', '+++ b/x',
    '@@ -1,6 +1,6 @@', ' one', ' two', '-three', '+THREE', ' four', ' five', ' six',
    '@@ -8,3 +8,4 @@', ' eight', ' nine', ' ten', '+eleven', ''].join('\n'));
  assert.equal(unifiedPatch(lineDiff('same', 'same')), '');
});

test('JSON: key order ignored when sorted, and changes listed by path', () => {
  const a = '{"id":1,"price":10,"tags":["a"],"meta":{"x":1,"y":2}}', b = '{"meta":{"y":2,"x":1},"price":"10","id":1,"tags":["a","b"],"new":null}';
  assert.equal(sortedJson('{"b":1,"a":{"d":1,"c":2}}'), '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}');
  assert.deepEqual(jsonChanges(JSON.parse(a), JSON.parse(b)), [
    { path: '$.price', kind: 'type', a: '10', b: '"10"' },
    { path: '$.tags[1]', kind: 'added', a: '', b: '"b"' },
    { path: '$.new', kind: 'added', a: '', b: 'null' }]);
  assert.deepEqual(jsonChanges({ 'odd key': [1, 2] }, { 'odd key': [1] }), [{ path: '$["odd key"][1]', kind: 'removed', a: '2', b: '' }]);
  assert.equal(jsonChanges({ a: Array.from({ length: 900 }, (_, i) => i) }, { a: [] }).length, 500);
});

test('large inputs stay fast', () => {
  const big = Array.from({ length: 60000 }, (_, i) => `line ${i}`).join('\n');
  const t0 = performance.now();
  assert.equal(diffStats(lineDiff(big, big.replace('line 30000', 'x').replace('line 7', 'y'))).hunks, 2);
  // Unrelated inputs need too many edits: shown as all removed, then all added, instead of freezing.
  assert.equal(diffStats(lineDiff(big, big.split('\n').reverse().join('\n'))).added, 60000);
  assert.ok(performance.now() - t0 < 3000);
});

test('tool helpers: JSON errors, JWT status, URL parts, HMAC, base64url', async () => {
  const { jsonError } = await import('../renderer/tools/tabs/json.js');
  const { jwtStatus } = await import('../renderer/tools/tabs/jwt.js');
  const { urlPartsHtml } = await import('../renderer/tools/tabs/url.js');
  const { digest } = await import('../renderer/tools/tabs/hash.js');
  assert.equal(jsonError('{"a":1}'), null);
  assert.deepEqual(jsonError('{\n  "a": 1,\n  "b": }'), { message: 'expected a value, found "}"', line: 3, col: 8 });
  assert.deepEqual(jsonError('{"a": 1,}'), { message: 'expected a "quoted" key, found "}"', line: 1, col: 9 });
  assert.deepEqual(jsonError('[1, 2'), { message: 'expected "," or "]", found the end', line: 1, col: 6 });
  assert.deepEqual(jsonError("{'a': 1}"), { message: 'expected a "quoted" key, found "\'"', line: 1, col: 2 });
  assert.equal(jsonError('{"a": "x\ny"}').message, 'expected the closing quote (line breaks must be written \\n), found "\\n"');
  const now = Date.UTC(2026, 0, 1);
  assert.deepEqual(jwtStatus({ exp: now / 1000 + 600 }, now), { cls: 'ok', text: 'Valid: expires in 10 minutes' });
  assert.deepEqual(jwtStatus({ exp: now / 1000 - 7200 }, now), { cls: 'bad', text: 'Expired 2 hours ago' });
  assert.equal(jwtStatus({ nbf: now / 1000 + 60 }, now).cls, 'warn');
  assert.equal(jwtStatus({}, now).text, 'No expiry (exp) claim');
  const parts = urlPartsHtml('https://api.example.com:8443/v1/pets%20x?limit=5&q=a%26b#top');
  for (const s of ['api.example.com', '8443', '/v1/pets x', 'top', 'Query parameters (2)', 'a&amp;b']) assert.ok(parts.includes(s), s);
  assert.equal(urlPartsHtml('not a url'), '');
  const msg = 'The quick brown fox jumps over the lazy dog';
  assert.equal((await digest('SHA-256', msg, 'key')).hex, 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  assert.equal((await digest('SHA-256', 'abc')).base64, 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  assert.equal((await digest('MD5', msg)).hex, '9e107d9d372bb6826bd81d3542a419d6');
});
