'use strict';
// Response times per request (the response-time trend and "slower than usual" flag), kept in
// timings.json in userData. History (main/history.js) keeps only the last 200 sends across every
// request, too few for one request's trend; this keeps a small sample per send instead.
// Shape: { [requestId]: [[at, ms, status, envId | null], …] }, oldest first, capped per request.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { replaceFile } = require('./fsutil');

const MAX_PER_REQUEST = 300;

function createTimingsStore(file) {
  let data = null;
  let timer = null;
  const load = () => {
    if (!data) { try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; } }
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    return data;
  };
  function flush() {
    clearTimeout(timer); timer = null;
    if (!data) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    replaceFile(file, JSON.stringify(data));
  }
  // Writes are batched, since a collection run sends many requests in a row.
  const persist = () => { clearTimeout(timer); timer = setTimeout(flush, 500); };
  return {
    all: () => load(),
    // sample: [at, ms, status, envId | null]
    append(reqId, sample) {
      if (!reqId || !Array.isArray(sample) || !Number.isFinite(sample[1])) return false;
      const list = (load()[reqId] ||= []);
      list.push(sample.slice(0, 4));
      if (list.length > MAX_PER_REQUEST) list.splice(0, list.length - MAX_PER_REQUEST);
      persist();
      return true;
    },
    // An emptied request stays as [] so the renderer doesn't seed it from History again.
    clear(reqId) { if (reqId) load()[reqId] = []; else data = {}; persist(); return true; },
    flush,
  };
}

function register(ipcMain) {
  const store = createTimingsStore(path.join(app.getPath('userData'), 'timings.json'));
  ipcMain.handle('timings-load', () => store.all());
  ipcMain.handle('timings-append', (_e, { reqId, sample } = {}) => store.append(reqId, sample));
  ipcMain.handle('timings-clear', (_e, reqId) => store.clear(reqId));
  app.on('before-quit', () => store.flush());
}

module.exports = { createTimingsStore, MAX_PER_REQUEST, register };
