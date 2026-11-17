// Collection runner breakpoints: pausing before a step (runCollection's beforeSend), editing the request or the
// run's variables there, skipping and stopping, and how skipped steps are reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { electronAPI: { storageSet() {}, historyAppend() {} } };
const { newReq } = await import('../renderer/app/store.js');
const { runCollection, summarize, toJUnit, varsUsed } = await import('../renderer/app/runner.js');

const locs = ['a', 'b', 'c'].map((n) => ({ p: { id: 'p' }, f: null, r: newReq({ name: n, url: `https://h/${n}` }) }));
const ok = (loc, vars) => ({ status: 200, time: 1, requestData: { method: loc.r.method, url: loc.r.url }, sentVars: vars });

test('beforeSend sees every step in order and can replace the request and variables', async () => {
  const seen = [], sent = [];
  const results = await runCollection(locs, async (loc, vars) => { sent.push([loc.r.url, vars.x]); return ok(loc, vars); }, {
    rows: [{ x: '1' }, { x: '2' }],
    beforeSend: async (loc, vars, pos) => {
      seen.push(`${pos.iteration}:${pos.index}`);
      if (loc.r.name === 'b') return { action: 'send', loc: { ...loc, r: { ...loc.r, url: 'https://h/edited' } }, vars: { ...vars, x: 'changed' } };
      return { action: 'send' };
    },
  });
  assert.deepEqual(seen, ['1:0', '1:1', '1:2', '2:0', '2:1', '2:2']);
  assert.deepEqual(sent.slice(0, 3), [['https://h/a', '1'], ['https://h/edited', 'changed'], ['https://h/c', '1']]);
  assert.equal(results[1].url, 'https://h/edited');
  assert.equal(results[1].edited, true);
  assert.equal(results[0].edited, undefined);
  assert.deepEqual(results[1].data, { x: 'changed' });
  assert.equal(locs[1].r.url, 'https://h/b', 'the saved request is untouched');
});

test('a pause can wait; skip records a skipped step, stop ends the run', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const sent = [];
  const run = runCollection(locs, async (loc) => { sent.push(loc.r.name); return ok(loc); }, {
    beforeSend: async (loc) => (loc.r.name === 'b' ? gate : loc.r.name === 'c' ? { action: 'stop' } : { action: 'send' }),
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ['a'], 'paused before b');
  release({ action: 'skip' });
  const results = await run;
  assert.deepEqual(sent, ['a']);
  assert.deepEqual(results.map((r) => [r.name, !!r.skipped, r.passed]), [['a', false, true], ['b', true, true]]);
  assert.deepEqual(summarize(results), { total: 2, passed: 1, failed: 0, time: 1, skipped: 1 });
  assert.match(toJUnit('run', results), /<testsuite name="run" tests="2" failures="0" skipped="1">/);
  assert.match(toJUnit('run', results), /<skipped message="skipped at a breakpoint"\/>/);
});

test('shouldStop while paused ends the run without sending', async () => {
  let stop = false;
  const sent = [];
  const results = await runCollection(locs, async (loc) => { sent.push(loc.r.name); return ok(loc); }, {
    shouldStop: () => stop,
    beforeSend: async (loc) => { if (loc.r.name === 'b') { stop = true; return { action: 'send' }; } return {}; },
  });
  assert.deepEqual(sent, ['a']);
  assert.equal(results.length, 1);
});

test('summaries without skipped steps keep their shape', () => {
  assert.deepEqual(summarize([{ passed: true, time: 2 }, { passed: false, time: 3 }]), { total: 2, passed: 1, failed: 1, time: 5 });
});

test('variables a request uses', () => {
  const r = newReq({ url: '{{baseUrl}}/pets/{{ petId }}?t={{$timestamp}}', headers: [{ k: 'X-Key', v: '{{apiKey}}', on: true }],
    body: { type: 'json', text: '{"owner":"{{owner}}","id":"{{petId}}"}', form: [] }, auth: { type: 'bearer', token: '{{token}}' } });
  assert.deepEqual(varsUsed(r), ['baseUrl', 'petId', 'apiKey', 'owner', 'token']);
});
