'use strict';
// Persists the renderer's whole DB object as one JSON file in userData. Its secrets (auth tokens and
// passwords, cookie jars, certificate passphrases, variables marked secret — see main/secrets.js) are sealed
// with the operating system's protection when encryption is on (main/vault.js; the default), and opened again
// on load, so the renderer only ever sees plain values. The file is also readable by your user account only.
// Turning encryption off or on rewrites the file (and accounts.json and the proxy's CA key) the other way.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { replaceFile } = require('./fsutil');
const { openSecretsAsync, sealSecretsAsync, hasSealed } = require('./secrets');
const vault = require('./vault');

const DB_PATH = path.join(app.getPath('userData'), 'db.json');
const wantsEncryption = (db) => db?.settings?.encryptSecrets !== false;

async function load() {
  let data;
  try { data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return {}; }
  if (!data?.db) return data;
  await vault.ready();
  vault.setEnabled(wantsEncryption(data.db));
  const sealed = hasSealed(data.db);
  if (sealed) {
    const failed = await openSecretsAsync(data.db, vault.decrypt);
    if (failed) data.secretsUnreadable = failed; // e.g. db.json copied from another computer or user account
  }
  // Bring the file in line with the setting now (plain secrets from an older version get sealed, a rotated
  // OS key gets used, and so on).
  if (sealed !== vault.active() || data.secretsUnreadable || vault.takeRekey()) await save(data, { quiet: true });
  return data;
}

// Saves are queued so they reach the disk in the order they were asked for (sealing is asynchronous).
let queue = Promise.resolve();
const save = (data, opts) => (queue = queue.then(() => write(data, opts), () => write(data, opts)));

// Write to a temp file and rename, so a crash mid-write can't leave a truncated db.json. `data` is this
// process's own copy (it came over IPC), so sealing in place doesn't touch the renderer's.
async function write(data, { quiet = false } = {}) {
  const { secretsUnreadable, ...rest } = data || {};
  await vault.ready();
  const changed = vault.setEnabled(wantsEncryption(rest.db));
  const out = quiet ? structuredClone(rest) : rest;
  if (out.db && vault.active()) await sealSecretsAsync(out.db, vault.encrypt);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  replaceFile(DB_PATH, JSON.stringify(out), { mode: 0o600 });
  if (changed) { await require('./accounts').resave(); await require('./proxy').resealCaKey?.(); }
  return true;
}

function register(ipcMain) {
  ipcMain.handle('storage-get', () => load());
  ipcMain.handle('storage-set', (_e, data) => save(data));
  // Settings → Privacy: whether secrets are encrypted, and with what (main/vault.js).
  ipcMain.handle('secrets-status', () => vault.statusAsync());
}

module.exports = { load, register };
