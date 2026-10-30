'use strict';
// Request history (the sidebar's History panel), kept in history.json in userData — separate
// from db.json so it can grow without slowing down saves of the projects themselves.
// Newest first, capped at MAX_ENTRIES; bodies over MAX_BODY are truncated on disk.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { replaceFile } = require('./fsutil');
const { redactHeaders, redactText, secretValues } = require('./secrets');

// Secret values the app holds (saved auth, secret variables, cookies, test-account passwords), removed from
// History bodies wherever they appear. Kept in a cache that's refreshed in the background at most every 15 s
// (opening them is asynchronous, and a burst of sends shouldn't re-read db.json); the pattern-based
// redaction applies regardless.
let known = { at: 0, values: [], refreshing: null };
async function refreshKnown() {
  const values = [];
  try { values.push(...secretValues((await require('./storage').load())?.db)); } catch { /* no data (tests, first run) */ }
  try { for (const a of await require('./accounts').load()) values.push(a.pass, a.totp); } catch { /* no accounts */ }
  known = { at: Date.now(), values, refreshing: null };
}
function knownSecrets() {
  if (Date.now() - known.at > 15000 && !known.refreshing) known.refreshing = refreshKnown().catch(() => { known.refreshing = null; });
  return known.values;
}

const MAX_ENTRIES = 200;
const MAX_BODY = 100 * 1024;

const cut = (s) => (typeof s === 'string' && s.length > MAX_BODY ? { text: s.slice(0, MAX_BODY), truncated: true } : { text: s, truncated: false });

// What's written to history.json: credential headers redacted, and the URL and both bodies with passwords,
// tokens, API keys and the app's saved secrets removed (secrets.js redactText: secret-named JSON, form and
// query fields, bearer tokens, JWTs, private keys, key formats). This session's in-memory entries keep them.
function trimForDisk(entry, secrets = knownSecrets()) {
  const clean = (s) => (typeof s === 'string' && s ? redactText(s, secrets) : s);
  const req = cut(clean(entry.request?.body));
  const res = entry.response && cut(clean(entry.response.body));
  return {
    ...entry,
    url: clean(entry.url),
    request: { ...entry.request, headers: redactHeaders(entry.request?.headers), body: req.text, ...(req.truncated && { truncated: true }) },
    response: entry.response && { ...entry.response, headers: redactHeaders(entry.response.headers), body: res.text, ...(res.truncated && { truncated: true }) },
    redacted: true,
  };
}

function createHistoryStore(file) {
  let entries = null;
  let timer = null;
  const load = () => {
    if (!entries) {
      try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { entries = []; }
      // Files from before bodies were redacted: cleaned once, the first time they're read.
      if (entries.some((e) => !e.redacted)) { entries = entries.map((e) => (e.redacted ? e : trimForDisk(e))); flush(); }
    }
    return entries;
  };
  function flush() {
    clearTimeout(timer); timer = null;
    if (!entries) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    replaceFile(file, JSON.stringify(entries));
  }
  // Writes are batched, since a burst of sends would otherwise rewrite the file each time.
  const persist = () => { clearTimeout(timer); timer = setTimeout(flush, 500); };
  return {
    list: () => load(),
    append(entry) { load().unshift(trimForDisk(entry)); if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES; persist(); return true; },
    remove(id) { entries = load().filter((e) => e.id !== id); persist(); return true; },
    clear() { entries = []; persist(); return true; },
    flush,
  };
}

function register(ipcMain) {
  knownSecrets(); // start filling the cache
  const store = createHistoryStore(path.join(app.getPath('userData'), 'history.json'));
  ipcMain.handle('history-load', () => store.list());
  ipcMain.handle('history-append', (_e, entry) => store.append(entry));
  ipcMain.handle('history-delete', (_e, id) => store.remove(id));
  ipcMain.handle('history-clear', () => store.clear());
  app.on('before-quit', () => store.flush());
}

module.exports = { createHistoryStore, trimForDisk, MAX_ENTRIES, MAX_BODY, register };
