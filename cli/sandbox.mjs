// A Web Worker stand-in for Node, so renderer/app/scripts.js runs scripts and assertions unchanged from
// the command line. scripts.js does `new Worker(blobUrl)` with workerMain's source, and keeps its own
// time limit (SCRIPT_TIMEOUT_MS), calling terminate() when it runs out; this runs that same source in a
// worker thread (cli/sandbox-thread.cjs) with an empty environment and a memory cap.
import { Worker as Thread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { workerMain } from '../renderer/app/script-worker.js';

const THREAD = fileURLToPath(new URL('./sandbox-thread.cjs', import.meta.url));
const SOURCE = `(${workerMain.toString()})();`; // what scripts.js puts in its Blob

export class SandboxWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.thread = new Thread(THREAD, { workerData: { source: SOURCE }, env: {}, argv: [], execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    this.thread.on('message', (data) => this.onmessage?.({ data }));
    this.thread.on('error', (err) => this.onerror?.({ message: err?.message || String(err) }));
  }
  postMessage(data) { this.thread.postMessage(data); }
  terminate() { this.thread.terminate(); }
}
