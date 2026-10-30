'use strict';
// Encrypting secrets on disk with the operating system's protection, through Electron's safeStorage:
// Windows: DPAPI (tied to your Windows login), macOS: a key in the Keychain, Linux: a key in the Secret
// Service (GNOME Keyring / KWallet). On by default (Settings → Privacy, db.json settings.encryptSecrets).
// What's sealed: the secrets in db.json (main/secrets.js walk), test-account passwords and TOTP secrets
// (main/accounts.js) and the proxy's CA key (main/proxy.js). Sealed values only open on this computer, for
// this user: moving to another computer goes through a backup that includes secrets.
// Uses safeStorage's asynchronous API (the synchronous one is deprecated): call ready() once before
// status() / active(); encrypt and decrypt return promises. Values sealed by the synchronous API open too.

let enabled = null; // the user's setting (null: not read yet); active() also needs the OS protection to be there
let safeStorage = null;
let checking = null, state = { available: false, backend: '' };
let rekey = false; // the OS rotated its key: data opened since should be written again (takeRekey)
const storage = () => (safeStorage ||= require('electron').safeStorage);

// The setting as db.json has it, for whichever file is opened first (accounts.json can be read before db.json).
function setting() {
  if (enabled !== null) return enabled;
  try {
    const { app } = require('electron');
    const data = JSON.parse(require('fs').readFileSync(require('path').join(app.getPath('userData'), 'db.json'), 'utf8'));
    enabled = data?.db?.settings?.encryptSecrets !== false;
  } catch { enabled = true; }
  return enabled;
}

// Whether the OS offers protection, checked once (after the app is ready). On Linux without a keyring Electron
// falls back to a fixed key ('basic_text'), which protects nothing, so that counts as unavailable.
// Waits for the app to be ready first: Electron sets up its asynchronous encryptor on the first call made
// after that, and a call made earlier (a module registering at startup) would wrongly find no protection.
function ready() {
  return (checking ||= (async () => {
    try {
      const { app } = require('electron');
      if (app?.whenReady) await app.whenReady();
      const ok = await storage().isAsyncEncryptionAvailable();
      const backend = process.platform === 'win32' ? 'Windows DPAPI' : process.platform === 'darwin' ? 'macOS Keychain'
        : (storage().getSelectedStorageBackend?.() || 'unknown');
      state = { available: !!ok && backend !== 'basic_text', backend };
    } catch { state = { available: false, backend: '' }; }
    return state;
  })());
}

// → { available, backend, enabled, active } as of the last ready() (statusAsync waits for it).
const status = () => ({ available: state.available, backend: state.backend, enabled: setting(), active: setting() && state.available });
const statusAsync = async () => { await ready(); return status(); };
const active = () => status().active;

// → true if the setting changed
function setEnabled(on) { const changed = setting() !== !!on; enabled = !!on; return changed; }

const encrypt = async (text) => (await storage().encryptStringAsync(String(text))).toString('base64');
async function decrypt(base64) {
  const { result, shouldReEncrypt } = await storage().decryptStringAsync(Buffer.from(base64, 'base64'));
  if (shouldReEncrypt) rekey = true;
  return result;
}
const takeRekey = () => { const r = rekey; rekey = false; return r; };

// Tests: check availability again (the fake OS protection changed).
const recheck = () => { checking = null; return ready(); };

module.exports = { ready, recheck, status, statusAsync, active, setEnabled, encrypt, decrypt, takeRekey };
