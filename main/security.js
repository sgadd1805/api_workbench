'use strict';
// App-wide Electron hardening:
//   - IPC handlers only answer the app's own pages (file:// pages inside the app folder); anything else,
//     e.g. a site in the login window, is refused even if it somehow reached ipcRenderer;
//   - permission requests (camera, microphone, location, notifications, MIDI, USB …) are denied, except
//     the clipboard for the app's own pages (Copy buttons); sites in the login window get none;
//   - <webview> can't be attached;
//   - webPreferences for app windows: sandboxed, isolated, no Node, and no spellchecker off macOS
//     (Chromium's would download dictionaries from Google; macOS uses the system's, offline).
const path = require('path');
const { fileURLToPath } = require('url');

const ROOT = path.resolve(__dirname, '..');

function isAppPage(url) {
  try {
    if (!url || !url.startsWith('file:')) return false;
    const file = path.resolve(fileURLToPath(url.split(/[?#]/)[0]));
    return file === ROOT || file.startsWith(ROOT + path.sep);
  } catch { return false; }
}

// Wraps ipcMain so every handler first checks who's calling.
function trustedIpc(ipcMain) {
  const check = (e, channel) => {
    const url = e.senderFrame?.url || e.sender?.getURL?.();
    if (!isAppPage(url)) throw new Error(`Refused ${channel}: not an app page (${String(url).slice(0, 80)})`);
  };
  return {
    handle: (channel, fn) => ipcMain.handle(channel, (e, ...args) => { check(e, channel); return fn(e, ...args); }),
    on: (channel, fn) => ipcMain.on(channel, (e, ...args) => { try { check(e, channel); } catch { return; } fn(e, ...args); }),
    removeHandler: (channel) => ipcMain.removeHandler(channel),
  };
}

const webPreferences = (extra = {}) => ({
  contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
  spellcheck: process.platform === 'darwin', ...extra,
});

// Copy buttons: Electron checks writeText as 'clipboard-read' (and requests 'clipboard-sanitized-write').
const CLIPBOARD = new Set(['clipboard-read', 'clipboard-sanitized-write']);

function harden(app, session) {
  // Checks only pass an origin ("file:///"), so the page's own URL decides whether it's an app page.
  const allow = (wc, permission, url) => CLIPBOARD.has(permission) && (isAppPage(wc?.getURL?.()) || isAppPage(url));
  const setup = (ses) => {
    ses.setPermissionRequestHandler((wc, permission, callback, details) => callback(allow(wc, permission, details?.requestingUrl)));
    ses.setPermissionCheckHandler((wc, permission, origin) => allow(wc, permission, origin));
  };
  setup(session.defaultSession);
  app.on('session-created', setup);
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
  });
}

module.exports = { isAppPage, trustedIpc, webPreferences, harden, ROOT };
