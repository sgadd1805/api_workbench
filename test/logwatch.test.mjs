// Log watch: matching rules, hit bookkeeping, lines flagged during a request.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const W = await import('../renderer/app/logwatch.js');
const line = (text, level = '', extra = {}) => ({ text, level, cont: false, ...extra });

test('matcher: levels, text and /regex/ patterns, continuation lines skipped', () => {
  const m = W.watchMatcher({ levels: true, patterns: 'Timeout, /payment .* failed/i, /bad[/' });
  assert.equal(m(line('boom', 'ERROR')), 'ERROR');
  assert.equal(m(line('down', 'FATAL')), 'FATAL');
  assert.equal(m(line('all good', 'INFO')), null);
  assert.equal(m(line('Read timeout after 30s', 'WARN')), 'Timeout');
  assert.equal(m(line('Payment for order 7 FAILED', 'INFO')), '/payment .* failed/i');
  assert.equal(m(line('\tat x.y(Z.java:1)', 'ERROR', { cont: true })), null);
  assert.equal(W.watchMatcher({ levels: false })(line('boom', 'ERROR')), null);
});

test('hits: counts per project, seen marker, during a request (with late lines)', () => {
  W.clearHits();
  W.addHits([{ projectId: 'P', at: 1000, text: 'a' }, { projectId: 'Q', at: 1500, text: 'b' }, { projectId: 'P', at: 5000, text: 'c' }]);
  assert.equal(W.unseenCount('P'), 2);
  W.markSeen();
  assert.equal(W.unseenCount('P'), 0);
  W.addHits([{ projectId: 'P', at: 3500, text: 'late' }]);
  assert.equal(W.unseenCount('P'), 1);
  assert.deepEqual(W.hitsDuring('P', 900, 1200).map((h) => h.text), ['a']);
  assert.deepEqual(W.hitsDuring('P', 900, 1200 + 1500).map((h) => h.text), ['a', 'late']); // within the 2 s grace
  assert.deepEqual(W.hitsFor('Q').map((h) => h.text), ['b']);
});
