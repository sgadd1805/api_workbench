'use strict';
// Test accounts for the toolbar's Creds buttons. Passwords and TOTP secrets stay in this process:
// the renderer gets a list without secrets, asks main to fill the login window, and fetches a password
// only to copy it. In accounts.json (readable by your user account only) they're sealed with the operating
// system's protection when encryption is on (main/vault.js), else plain.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { replaceFile } = require('./fsutil');
const crypto = require('crypto');
const { generateTotp, secondsLeft } = require('./totp');
const { fillCredentials } = require('./login');

const FILE = path.join(app.getPath('userData'), 'accounts.json');

// Stored shape: { version: 2, accounts: [{ id, env, label, user, pass, totp }] }, pass / totp plain or
// { $secret } (version 1 was a bare array with keychain-encrypted strings). → accounts with plain secrets;
// ones that can't be opened here (another computer or user account) come back empty.
async function load() {
  let data;
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
  await vault.ready();
  const v1 = Array.isArray(data);
  const stored = v1 ? data.map((a) => ({ ...a, pass: a.pass && { $secret: a.pass }, totp: a.totp && { $secret: a.totp } })) : data?.accounts || [];
  const accounts = await Promise.all(stored.map(async (a) => ({ ...a, pass: (await openValue(a.pass, vault.decrypt)).value, totp: (await openValue(a.totp, vault.decrypt)).value })));
  // Bring the file in line with the encryption setting (older files, the setting changed meanwhile, a rotated OS key).
  const sealed = stored.some((a) => isSealed(a.pass) || isSealed(a.totp));
  if (v1 || vault.takeRekey() || (accounts.some((a) => a.pass || a.totp) && sealed !== vault.active())) await write(accounts);
  return accounts;
}
async function write(accounts) {
  await vault.ready();
  const enc = vault.active() ? vault.encrypt : null;
  const sealed = await Promise.all(accounts.map(async (a) => ({ ...a, pass: await sealValue(a.pass, enc), totp: await sealValue(a.totp, enc) })));
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  replaceFile(FILE, JSON.stringify({ version: 2, accounts: sealed }, null, 2), { mode: 0o600 });
}
// Rewrites accounts.json after the encryption setting changed.
async function resave() { try { if (fs.existsSync(FILE)) await write(await load()); } catch { /* left as it is: read correctly either way */ } }
const vault = require('./vault');
const { sealValue, openValue, isSealed } = require('./secrets');

// What the renderer may see.
const publicView = (a) => ({ id: a.id, env: a.env, label: a.label, user: a.user, hasPass: !!a.pass, hasTotp: !!a.totp });
const list = async () => (await load()).map(publicView);
const find = async (id) => (await load()).find((a) => a.id === id);

// edits: [{ id?, env, label, user, pass?, totp? }]. An omitted/empty pass or totp keeps the stored
// one; `clearPass` / `clearTotp` remove it. Accounts missing from `edits` are deleted.
async function save(edits) {
  const old = new Map((await load()).map((a) => [a.id, a]));
  const next = edits.map((e) => {
    const prev = old.get(e.id) || {};
    return {
      id: e.id || crypto.randomUUID(),
      env: String(e.env || '').trim(),
      label: String(e.label || '').trim() || String(e.user || '').split('@')[0] || 'account',
      user: String(e.user || ''),
      pass: e.clearPass ? '' : e.pass ? String(e.pass) : prev.pass || '',
      totp: e.clearTotp ? '' : e.totp ? e.totp.replace(/\s+/g, '') : prev.totp || '',
    };
  });
  await write(next);
  return next.map(publicView);
}

// For a full backup (renderer/app/backup.js): every account, with passwords and TOTP secrets only when asked.
const backupList = async (includeSecrets) => (await load()).map((a) => (includeSecrets ? { ...a } : { ...a, pass: '', totp: '' }));
// Restoring a backup: accounts matched by label + environment are updated (a password or TOTP secret only
// when the backup has one), others are added. → number added
async function restore(list) {
  const accounts = await load();
  let added = 0;
  for (const b of list || []) {
    const a = accounts.find((x) => x.label === b.label && (x.env || '') === (b.env || ''));
    if (a) { a.user = b.user ?? a.user; if (b.pass) a.pass = b.pass; if (b.totp) a.totp = b.totp; }
    else { accounts.push({ id: crypto.randomUUID(), env: b.env || '', label: b.label || 'account', user: b.user || '', pass: b.pass || '', totp: b.totp || '' }); added++; }
  }
  await write(accounts);
  return added;
}

const guard = (fn) => async (...args) => { try { return await fn(...args); } catch (err) { return { ok: false, error: err.message }; } };

function register(ipcMain) {
  ipcMain.handle('accounts-list', () => list());
  ipcMain.handle('accounts-backup', (_e, includeSecrets) => backupList(!!includeSecrets));
  ipcMain.handle('accounts-restore', guard(async (_e, list) => ({ ok: true, added: await restore(list) })));
  ipcMain.handle('accounts-save', guard(async (_e, edits) => ({ ok: true, accounts: await save(edits) })));
  ipcMain.handle('accounts-fill', guard(async (_e, id) => {
    const a = await find(id); if (!a) return { ok: false, error: 'Unknown account' };
    return fillCredentials({ username: a.user, password: a.pass });
  }));
  ipcMain.handle('accounts-secret', guard(async (_e, { id, field }) => {
    const a = await find(id); if (!a || !['pass', 'totp'].includes(field)) return { ok: false, error: 'Unknown account' };
    return { ok: true, value: a[field] || '' };
  }));
  ipcMain.handle('accounts-totp', guard(async (_e, id) => {
    const a = await find(id); if (!a?.totp) return { ok: false, error: 'No TOTP secret' };
    const code = generateTotp(a.totp);
    return code ? { ok: true, code, secondsLeft: secondsLeft() } : { ok: false, error: 'Bad TOTP secret' };
  }));
}

module.exports = { load, resave, register };
