// Shared renderer helpers and the Tools window's pure libraries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc } from '../renderer/shared/html.js';
import { lineDiff, diffHtml } from '../renderer/shared/diff.js';
import { highlightJson, prettyJson, isJson } from '../renderer/shared/json.js';
import { md5 } from '../renderer/tools/lib/md5.js';
import { b64enc, b64dec, decodeJwt } from '../renderer/tools/lib/codec.js';
import { unescapeJson, STRING_OPS } from '../renderer/tools/lib/strings.js';
import { relTime, parseTimestamp } from '../renderer/tools/lib/time.js';

test('esc', () => {
  assert.equal(esc(`<a href="x">it's & </a>`), '&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; &lt;/a&gt;');
  assert.equal(esc(null), '');
});

test('lineDiff', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nx\nc'), [
    { type: 'same', text: 'a', a: 1, b: 1 }, { type: 'del', text: 'b', a: 2, b: null }, { type: 'add', text: 'x', a: null, b: 2 }, { type: 'same', text: 'c', a: 3, b: 3 }]);
  assert.deepEqual(lineDiff('same', 'same'), [{ type: 'same', text: 'same', a: 1, b: 1 }]);
  assert.match(diffHtml([{ type: 'add', text: '<b>' }]), /class="diff-row diff-add" data-hunk="0"><span class="diff-sign">\+<\/span>&lt;b&gt;/);
});

test('lineDiff stays fast on large inputs', () => {
  const big = Array.from({ length: 20000 }, (_, i) => 'line ' + i).join('\n');
  const t0 = performance.now();
  const rows = lineDiff(big, big.replace('line 10000', 'changed'));
  assert.equal(rows.filter((r) => r.type !== 'same').length, 2);
  const a = Array.from({ length: 3000 }, (_, i) => 'a' + i).join('\n'), b = a.replace(/a/g, 'b');
  assert.equal(lineDiff(a, b).length, 6000); // over the edit cap: all removed, then all added
  assert.ok(performance.now() - t0 < 2000);
});

test('json helpers', () => {
  assert.equal(prettyJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyJson('nope'), 'nope');
  assert.ok(isJson('[1]') && !isJson('{'));
  assert.equal(highlightJson('{"k": "v<", "n": 1}'),
    '{<span class="json-key">&quot;k&quot;</span>: <span class="json-str">&quot;v&lt;&quot;</span>, <span class="json-key">&quot;n&quot;</span>: <span class="json-num">1</span>}');
});

test('md5', () => {
  assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
});

test('base64 and JWT', () => {
  assert.equal(b64enc('héllo'), 'aMOpbGxv');
  assert.equal(b64dec('aMOpbGxv'), 'héllo');
  assert.equal(b64dec('aGk_Pz8-'), 'hi???>');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMiLCJleHAiOjE3MDAwMDAwMDB9.sig';
  assert.deepEqual(decodeJwt(jwt), { header: { alg: 'HS256' }, payload: { sub: '123', exp: 1700000000 } });
  assert.equal(decodeJwt('a.b'), null);
});

test('string ops', () => {
  assert.equal(unescapeJson('He said \\"hi\\"\\n'), 'He said "hi"\n');
  assert.equal(unescapeJson('a "b"'), 'a "b"');
  assert.equal(unescapeJson('bad \\q'), 'bad \\q');
  const ops = Object.fromEntries(STRING_OPS.map(([id, , fn]) => [id, fn]));
  assert.equal(ops['dedup-lines']('a\nb\na'), 'a\nb');
  assert.equal(ops['escape-json']('a"\n'), 'a\\"\\n');
});

test('time', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(relTime(new Date(now - 90_000), now), '2 minutes ago');
  assert.equal(relTime(new Date(now + 1000), now), 'in 1 second');
  assert.equal(parseTimestamp('1700000000').getTime(), 1700000000000);
  assert.equal(parseTimestamp('1700000000123').getTime(), 1700000000123);
  assert.ok(isNaN(parseTimestamp('nope')));
});

