// The sandbox for user-written code: pre-request / post-response scripts and assertions. It runs in a
// Web Worker made from a Blob (renderer/app/scripts.js), so:
//   - it can't touch the app's UI or window.electronAPI (no file, terminal or network access through the app);
//   - it inherits the page's Content-Security-Policy, so it can't fetch or import anything from the network;
//   - a slow or looping script is stopped (the worker is terminated on timeout).
// Network APIs are also removed before any user code runs.
// workerMain is turned into the worker's source with Function.prototype.toString, so it must not use
// anything outside its own body.
//
// Script in:  { code, phase: 'pre' | 'post', request, response?, vars }
// Script out: { ok, request, setVars, tests: [{ name, ok, error }], logs: [string], next, error? }
// Assertions in: { phase: 'assert', assertions: [expr], status, body } → out: { assertions: [{ expr, ok, err? }] }
export function workerMain() {
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'importScripts', 'Request', 'BroadcastChannel', 'SharedWorker', 'Worker', 'indexedDB', 'caches']) {
  // Remove it wherever it's defined (the global or its prototypes), then pin it to undefined.
  for (let o = self; o; o = Object.getPrototypeOf(o)) { try { if (Object.hasOwn(o, name)) delete o[name]; } catch { /* not deletable */ } }
  try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }); } catch { /* not present */ }
}
self.onmessage = async ({ data }) => {
  if (data.phase === 'assert') {
    let parsed = data.body; try { parsed = JSON.parse(data.body); } catch { /* not JSON */ }
    const assertions = data.assertions.filter((l) => l.trim()).map((expr) => {
      try { return { expr, ok: !!Function('status', 'body', `"use strict"; return (${expr});`)(data.status, parsed) }; } catch (e) { return { expr, ok: false, err: e.message }; }
    });
    self.postMessage({ assertions });
    return;
  }
  const logs = [], tests = [], setVars = {};
  const vars = { ...data.vars };
  let next;
  const request = structuredClone(data.request);
  const body = data.response?.body ?? '';
  const response = data.response && {
    ...data.response,
    json() { return JSON.parse(body); },
    header(name) { return Object.entries(data.response.headers || {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]; },
  };
  const fmt = (v) => (typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());
  const enc = new TextEncoder();
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const ctx = {
    request, response,
    vars: {
      get: (name) => vars[name],
      set: (name, value) => { vars[name] = String(value); setVars[name] = String(value); },
      all: () => ({ ...vars }),
    },
    log: (...args) => logs.push(args.map(fmt).join(' ')),
    test: async (name, fn) => {
      try { const r = await fn(); tests.push({ name, ok: r !== false }); } catch (e) { tests.push({ name, ok: false, error: e.message }); }
    },
    expect: (actual) => ({
      toBe: (expected) => { if (actual !== expected) throw new Error(`expected ${fmt(expected)}, got ${fmt(actual)}`); },
      toEqual: (expected) => { if (fmt(actual) !== fmt(expected)) throw new Error(`expected ${fmt(expected)}, got ${fmt(actual)}`); },
      toContain: (part) => { if (!String(actual).includes(part)) throw new Error(`expected to contain ${fmt(part)}`); },
      toBeTruthy: () => { if (!actual) throw new Error(`expected a truthy value, got ${fmt(actual)}`); },
    }),
    setNextRequest: (name) => { next = name; }, // collection runner only: name of the request to run next (null = stop)
    uuid: () => crypto.randomUUID(),
    now: () => Date.now(),
    crypto: {
      hmac: async (algo, key, message, as = 'hex') => {
        const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: algo }, false, ['sign']);
        const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
        return as === 'base64' ? b64(sig) : hex(sig);
      },
      sha: async (algo, message, as = 'hex') => { const d = await crypto.subtle.digest(algo, enc.encode(message)); return as === 'base64' ? b64(d) : hex(d); },
      base64: (s) => btoa(String.fromCharCode(...enc.encode(s))),
    },
  };
  try {
    const AsyncFunction = (async () => {}).constructor;
    await new AsyncFunction('ctx', 'request', 'response', 'vars', 'log', 'test', 'expect', `"use strict";\n${data.code}`)(ctx, ctx.request, ctx.response, ctx.vars, ctx.log, ctx.test, ctx.expect);
    self.postMessage({ ok: true, request, setVars, tests, logs, next });
  } catch (e) {
    self.postMessage({ ok: false, error: `${e.name}: ${e.message}`, request, setVars, tests, logs, next });
  }
};
}
