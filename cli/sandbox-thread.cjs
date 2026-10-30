'use strict';
// The worker thread behind cli/sandbox.mjs. It runs the app's own sandbox code (workerMain from
// renderer/app/script-worker.js) inside a fresh node:vm context, so user scripts and assertions see the
// same globals as in the app's Web Worker (self, postMessage, crypto.subtle / randomUUID, btoa / atob,
// TextEncoder, structuredClone, setTimeout) and nothing else: no require, process, fs or network.
//
// Only strings and numbers cross between the context and this thread: messages travel as JSON text and
// crypto results as hex, so no object from outside the context is reachable from a script (which would
// otherwise lead back to this thread's Function and process). The thread also starts with an empty
// environment (cli/sandbox.mjs), so it holds no CI secrets. node:vm is not a security boundary in the
// way Chromium's process sandbox is; this keeps honest scripts honest and an accident contained.
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const context = vm.createContext({}, { codeGeneration: { strings: true, wasm: false } });

// Runs inside the context. `outside` holds functions of this thread that take and return primitives only;
// they stay in this closure, out of reach of user code.
const PRELUDE = `(function (outside) {
  'use strict';
  const g = globalThis;
  g.self = g;
  // Errors thrown out there are replaced by ones made in here.
  const wrap = (fn) => (...args) => { try { return fn(...args); } catch (e) { throw new Error(String(e && e.message)); } };
  const host = {};
  for (const k of Object.keys(outside)) host[k] = wrap(outside[k]);
  const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const fromHex = (hex) => { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16); return out; };
  const bytesOf = (data) => {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('Expected an ArrayBuffer or typed array');
  };
  const hashName = (h) => String(typeof h === 'string' ? h : h && h.name);

  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(s = '') { const bin = unescape(encodeURIComponent(String(s))); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  }
  class TextDecoder {
    get encoding() { return 'utf-8'; }
    decode(data) { if (data === undefined) return ''; let bin = ''; for (const b of bytesOf(data)) bin += String.fromCharCode(b); return decodeURIComponent(escape(bin)); }
  }
  g.TextEncoder = TextEncoder;
  g.TextDecoder = TextDecoder;
  g.btoa = (s) => host.btoa(String(s));
  g.atob = (s) => host.atob(String(s));
  g.structuredClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  g.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} }; // scripts report through log()

  const timers = new Map();
  let nextTimer = 1;
  g.setTimeout = (fn, ms = 0, ...args) => { const id = nextTimer++; timers.set(id, () => fn(...args)); host.timer(id, Number(ms) || 0); return id; };
  g.clearTimeout = (id) => { timers.delete(id); };

  g.crypto = {
    randomUUID: () => host.uuid(),
    getRandomValues: (arr) => { const bytes = fromHex(host.random(arr.length)); for (let i = 0; i < arr.length; i++) arr[i] = bytes[i]; return arr; },
    subtle: {
      importKey: async (format, keyData, algorithm) => {
        if (format !== 'raw') throw new Error('Only raw keys are supported');
        return { type: 'secret', algorithm: { name: 'HMAC', hash: { name: hashName(algorithm && algorithm.hash) } }, hex: hexOf(bytesOf(keyData)) };
      },
      sign: async (algorithm, key, data) => fromHex(host.hmac(hashName(key.algorithm.hash), key.hex, hexOf(bytesOf(data)))).buffer,
      digest: async (algorithm, data) => fromHex(host.digest(hashName(algorithm), hexOf(bytesOf(data)))).buffer,
    },
  };

  g.postMessage = (data) => host.post(JSON.stringify(data));
  return {
    deliver: (json) => { if (typeof g.onmessage === 'function') g.onmessage({ data: JSON.parse(json) }); },
    fire: (id) => { const fn = timers.get(id); timers.delete(id); if (fn) fn(); },
  };
})`;

const NODE_HASH = { 'SHA-1': 'sha1', 'SHA-256': 'sha256', 'SHA-384': 'sha384', 'SHA-512': 'sha512' };
const nodeHash = (name) => {
  const h = NODE_HASH[String(name).toUpperCase()];
  if (!h) throw new Error(`Unsupported hash ${name}`);
  return h;
};

let inside;
const host = Object.freeze({
  post: (json) => parentPort.postMessage(JSON.parse(json)),
  timer: (id, ms) => { setTimeout(() => inside.fire(id), ms); },
  uuid: () => nodeCrypto.randomUUID(),
  random: (n) => nodeCrypto.randomBytes(n).toString('hex'),
  hmac: (hash, keyHex, dataHex) => nodeCrypto.createHmac(nodeHash(hash), Buffer.from(keyHex, 'hex')).update(Buffer.from(dataHex, 'hex')).digest('hex'),
  digest: (hash, dataHex) => nodeCrypto.createHash(nodeHash(hash)).update(Buffer.from(dataHex, 'hex')).digest('hex'),
  btoa: (s) => {
    if (/[^\u0000-ÿ]/.test(s)) throw new Error('The string to be encoded contains characters outside of the Latin1 range.');
    return Buffer.from(s, 'latin1').toString('base64');
  },
  atob: (s) => Buffer.from(s, 'base64').toString('latin1'),
});

inside = vm.runInContext(PRELUDE, context)(host);
vm.runInContext(workerData.source, context, { filename: 'sandbox.js' });
parentPort.on('message', (data) => inside.deliver(JSON.stringify(data)));
