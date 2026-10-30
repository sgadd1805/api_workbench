// window.electronAPI for the command-line runner: the calls a collection run makes (preload.js names),
// answered by the main-process modules directly instead of over IPC. Importing this module installs it
// (and the script sandbox, cli/sandbox.mjs) as globals, so import it before any renderer module.
//
// The run never writes the app's data: saving the DB, history and timings are no-ops, and specs a
// --config run attaches are kept in memory.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { SandboxWorker } from './sandbox.mjs';

const require = createRequire(import.meta.url);
const http = require('../main/http.js');
const protocols = require('../main/protocols.js');
const specs = require('../main/specs.js');

const state = { dataDir: null, specDocs: new Map() }; // spec id → document (attached by --config)

// dataDir: the app's user-data folder (for specs/<id>.json), or null.
export function configureApi({ dataDir = null } = {}) {
  state.dataDir = dataDir;
  state.specDocs.clear();
}

const specFile = (id) => path.join(state.dataDir, 'specs', String(id).replace(/[^\w-]/g, '') + '.json');
const guard = async (fn) => { try { return { ok: true, ...(await fn()) }; } catch (err) { return { ok: false, error: err.message }; } };

export const nodeApi = {
  // main/http.js, main/protocols.js
  doFetch: (opts) => http.proxyFetch(opts),
  cancelFetch: (id) => http.cancel(id),
  grpcCall: (opts) => protocols.grpcCall(opts),
  grpcCancel: (id) => protocols.grpcCancel({ id }),
  // main/specs.js
  specsRead: (location) => guard(() => specs.readSpec(location)),
  specStoreSave: async (id, doc) => { state.specDocs.set(id, doc); return { ok: true }; },
  specStoreLoad: (id) => guard(() => {
    if (state.specDocs.has(id)) return { doc: state.specDocs.get(id) };
    if (!state.dataDir) throw new Error('No spec store');
    return { doc: JSON.parse(fs.readFileSync(specFile(id), 'utf8')) };
  }),
  // Writes the app would make; a command-line run leaves the app's data as it was.
  storageSet: () => true,
  historyAppend: () => true,
  timingsAppend: () => true,
};

globalThis.window ||= {};
globalThis.window.electronAPI = nodeApi;
globalThis.Worker = SandboxWorker;
