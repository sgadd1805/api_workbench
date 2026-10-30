// Secrets encrypted on disk (main/vault.js, main/storage.js, main/accounts.js, proxy CA key), with a stand-in
// for Electron: a temporary user-data folder and a fake safeStorage (DPAPI / Keychain in the real app) that
// only has the asynchronous API, so nothing can still be using the deprecated synchronous one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
const fake = { available: true, other: false, rotated: false };
const rev = (s) => [...s].reverse().join('');
const safeStorage = {
  isAsyncEncryptionAvailable: async () => fake.available,
  // After a key rotation new ciphertext is "ENC2:", and "ENC:" still opens but asks to be re-encrypted.
  encryptStringAsync: async (s) => Buffer.from((fake.rotated ? 'ENC2:' : 'ENC:') + rev(s)),
  // "Another computer": ciphertext from here doesn't open.
  decryptStringAsync: async (b) => {
    const t = b.toString(), m = /^(ENC2?):/.exec(t);
    if (fake.other || !m) throw new Error('cannot decrypt');
    return { result: rev(t.slice(m[0].length)), shouldReEncrypt: fake.rotated && m[1] === 'ENC' };
  },
};
require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: { app: { getPath: () => dir, on() {} }, safeStorage, BrowserWindow: class {}, shell: {}, dialog: {} } };

const storage = require('../main/storage.js');
const accounts = require('../main/accounts.js');
const proxy = require('../main/proxy.js');
const vault = require('../main/vault.js');
const { sealSecrets, openSecrets, sealSecretsAsync, openSecretsAsync, sealValue, openValue } = require('../main/secrets.js');

const ipc = { handlers: {}, handle(name, fn) { this.handlers[name] = fn; } };
storage.register(ipc);
accounts.register(ipc);
const save = (db) => ipc.handlers['storage-set'](null, structuredClone({ db }));
const load = () => ipc.handlers['storage-get']();
const onDisk = (file) => fs.readFileSync(path.join(dir, file), 'utf8');
const sample = (settings = {}) => ({ settings: { mcp: { enabled: true, token: 'mcp-TOKEN-SECRET' }, ...settings }, projects: [{ name: 'P', auth: { type: 'bearer', token: 'tok-SECRET' }, cookies: 'sid=COOKIE', folders: [], requests: [{ auth: { type: 'basic', user: 'bo', pass: 'pw-SECRET' } }],
  envs: [{ name: 'e', vars: [{ k: 'apiKey', v: 'key-SECRET', secret: true }, { k: 'baseUrl', v: 'http://localhost' }], network: { passphrase: 'pfx-SECRET' } }] }] });

test('seal / open helpers, synchronous and asynchronous', async () => {
  const enc = (s) => `x${s}`, dec = (s) => { if (!s.startsWith('x')) throw new Error('bad'); return s.slice(1); };
  const db = sample();
  assert.equal(sealSecrets(db, enc), 6);
  assert.deepEqual(db.projects[0].auth.token, { $secret: 'xtok-SECRET' });
  assert.equal(db.projects[0].envs[0].vars[1].v, 'http://localhost', 'non-secret values stay plain');
  assert.equal(openSecrets(db, dec), 0);
  assert.equal(db.projects[0].envs[0].network.passphrase, 'pfx-SECRET');
  const aenc = async (s) => enc(s), adec = async (s) => dec(s);
  assert.equal(await sealSecretsAsync(db, aenc), 6);
  db.projects[0].cookies = { $secret: 'garbage' };
  assert.equal(await openSecretsAsync(db, adec), 1, 'one that does not open is counted and cleared');
  assert.deepEqual([db.projects[0].auth.token, db.projects[0].cookies], ['tok-SECRET', '']);
  assert.deepEqual([await sealValue('', aenc), await sealValue('a', null), await sealValue('a', aenc)], ['', 'a', { $secret: 'xa' }]);
  assert.deepEqual([await openValue({ $secret: 'xa' }, adec), await openValue({ $secret: 'zz' }, adec), await openValue('plain', adec)], [{ value: 'a', failed: false }, { value: '', failed: true }, { value: 'plain', failed: false }]);
});

test('db.json: secrets sealed on save by default, opened on load, never plain on disk', async () => {
  await save(sample());
  const text = onDisk('db.json');
  for (const s of ['tok-SECRET', 'COOKIE', 'pw-SECRET', 'key-SECRET', 'pfx-SECRET', 'mcp-TOKEN-SECRET']) assert.ok(!text.includes(s), s);
  assert.ok(text.includes('"$secret"') && text.includes('http://localhost'));
  const back = await load();
  assert.equal(back.db.projects[0].auth.token, 'tok-SECRET');
  assert.equal(back.db.projects[0].envs[0].vars[0].v, 'key-SECRET');
  assert.equal(back.secretsUnreadable, undefined);
  assert.deepEqual(await ipc.handlers['secrets-status'](), { available: true, backend: vault.status().backend, enabled: true, active: true });
});

test('saves land in order, even though sealing is asynchronous', async () => {
  await Promise.all([1, 2, 3, 4, 5].map((n) => save({ ...sample(), projects: [{ ...sample().projects[0], name: `P${n}` }] })));
  assert.equal(JSON.parse(onDisk('db.json')).db.projects[0].name, 'P5');
});

test('accounts.json and the proxy CA key follow the setting; turning it off and on rewrites them', async () => {
  await ipc.handlers['accounts-save'](null, [{ label: 'Admin', user: 'a@x.test', pass: 'acct-PW', totp: 'JBSWY3DPEHPK3PXP' }]);
  assert.ok(!onDisk('accounts.json').includes('acct-PW') && onDisk('accounts.json').includes('$secret'));
  assert.equal((await accounts.load())[0].pass, 'acct-PW');
  assert.equal((await ipc.handlers['accounts-secret'](null, { id: (await accounts.load())[0].id, field: 'pass' })).value, 'acct-PW');
  fs.mkdirSync(path.join(dir, 'proxy-ca'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'proxy-ca', 'ca.key'), '-----BEGIN PRIVATE KEY-----\nKEY\n');
  await proxy.resealCaKey();
  assert.match(onDisk('proxy-ca/ca.key'), /^sealed:/);

  await save(sample({ encryptSecrets: false }));
  assert.ok(onDisk('db.json').includes('tok-SECRET') && !onDisk('db.json').includes('$secret'), 'db.json plain');
  assert.ok(onDisk('accounts.json').includes('acct-PW'), 'accounts.json plain');
  assert.match(onDisk('proxy-ca/ca.key'), /^-----BEGIN PRIVATE KEY/, 'CA key plain');
  assert.equal(vault.status().active, false);

  await save(sample({ encryptSecrets: true }));
  assert.ok(!onDisk('db.json').includes('tok-SECRET') && !onDisk('accounts.json').includes('acct-PW'));
  assert.match(onDisk('proxy-ca/ca.key'), /^sealed:/);
});

test('plain data from an older version is sealed on first load', async () => {
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ db: sample() }));
  const back = await load();
  assert.equal(back.db.projects[0].auth.token, 'tok-SECRET');
  await save(back.db); // the migration write is queued with saves
  assert.ok(!onDisk('db.json').includes('tok-SECRET'), 'rewritten sealed');
});

test('a rotated OS key: data still opens, and is written again with the new key', async () => {
  await save(sample());
  assert.ok(onDisk('db.json').includes(Buffer.from('ENC:').toString('base64').slice(0, 4)));
  fake.rotated = true;
  const back = await load();
  assert.equal(back.db.projects[0].auth.token, 'tok-SECRET');
  await save(back.db);
  const sealed = JSON.parse(onDisk('db.json')).db.projects[0].auth.token.$secret;
  assert.match(Buffer.from(sealed, 'base64').toString(), /^ENC2:/, 're-encrypted with the new key');
  fake.rotated = false;
});

test('data encrypted elsewhere: unreadable secrets are cleared and reported', async () => {
  await save(sample());
  fake.other = true;
  const back = await load();
  assert.equal(back.secretsUnreadable, 6);
  assert.equal(back.db.projects[0].auth.token, '');
  assert.equal((await accounts.load())[0].pass, '', 'an account password that does not open comes back empty');
  fake.other = false;
});

test('no protection available (Linux without a keyring): stored plain, reported as such', async () => {
  fake.available = false; await vault.recheck();
  await save(sample());
  assert.ok(onDisk('db.json').includes('tok-SECRET'));
  assert.deepEqual([vault.status().available, vault.status().active, vault.status().enabled], [false, false, true]);
  fake.available = true; await vault.recheck();
});
