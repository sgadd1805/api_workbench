'use strict';
// The login window: a plain Chromium window (no preload) for signing in to the target site,
// with console + network capture and a credential filler driven from the toolbar.
const { BrowserWindow } = require('electron');
const { webPreferences } = require('./security');
const { windows, alive } = require('./windows');
const { attachNetworkCapture, recorder, findBearerToken } = require('./har');

const MAX_CONSOLE_LOGS = 500;
let consoleLogs = [];

function createLoginWindow() {
  consoleLogs = [];
  const win = new BrowserWindow({ width: 1100, height: 800, webPreferences: webPreferences() }); // no preload: real sites get no app API
  win.on('closed', () => { windows.login = null; });
  win.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
    consoleLogs.push({ level, message, line, sourceId });
    if (consoleLogs.length > MAX_CONSOLE_LOGS) consoleLogs.shift();
  });
  attachNetworkCapture(win);
  return win;
}

async function openLoginWindow(url) {
  const target = url || 'https://example.com';
  try {
    if (!/^https?:$/.test(new URL(target).protocol)) throw new Error('bad protocol');
  } catch {
    return { ok: false, error: 'Enter a valid http(s) URL' };
  }
  const win = alive(windows.login) || (windows.login = createLoginWindow());
  // loadURL rejects on DNS/TLS errors and on aborted navigations (e.g. SSO redirects);
  // show the window either way so the error page or the redirected page is visible.
  let error = null;
  try { await win.loadURL(target); } catch (err) { error = err.message; }
  win.show();
  win.focus();
  if (!win.webContents.isDevToolsOpened()) win.webContents.openDevTools();
  return { ok: true, error };
}

// Runs inside the login page. Most specific selector first; a bare text input (e.g. a search box) is the last resort.
function fillScript(username, password) {
  return `
    (function(u, p) {
      function fill(el, val) {
        if (!el) return false;
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        desc.set.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
      const pick = (sels) => {
        for (const s of sels) {
          const el = [...document.querySelectorAll(s)].find((e) => !e.disabled && visible(e));
          if (el) return el;
        }
        return null;
      };
      const userEl = pick(['input[autocomplete="username"]', 'input[type="email"]', 'input[name="username"]',
        'input[name="user"]', 'input[type="text"]']);
      const passEl = pick(['input[type="password"]']);
      return { user: fill(userEl, u), pass: fill(passEl, p) };
    })(${JSON.stringify(username || '')}, ${JSON.stringify(password || '')})
  `;
}

async function fillCredentials({ username, password }) {
  const win = alive(windows.login);
  if (!win) return { ok: false, error: 'Login window not open' };
  try {
    return { ok: true, ...(await win.webContents.executeJavaScript(fillScript(username, password))) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// The signed-in session, for reuse in API requests: cookies the login window would send to `url`
// (or to its own page when url isn't a valid URL) plus the latest bearer token in the capture.
async function loginSession(url) {
  const win = alive(windows.login);
  if (!win) return { ok: false, error: 'Open the login window and sign in first' };
  let target = win.webContents.getURL();
  try { if (/^https?:$/.test(new URL(url).protocol)) target = url; } catch {}
  const cookies = target ? await win.webContents.session.cookies.get({ url: target }) : [];
  const found = findBearerToken(recorder.entries);
  return {
    ok: true,
    target,
    cookies: cookies.map((c) => `${c.name}=${c.value}`),
    token: found?.token ?? null,
    tokenSource: found?.source ?? null,
  };
}

function register(ipcMain) {
  ipcMain.handle('open-login-window', (_e, { url } = {}) => openLoginWindow(url));
  // Hides (not closes) the login window so re-opening doesn't require logging in again.
  ipcMain.handle('hide-login-window', () => { alive(windows.login)?.hide(); return true; });
  ipcMain.handle('login-session', (_e, { url } = {}) => loginSession(url));
  // One login window, not a full tab strip.
  ipcMain.handle('list-tabs', () => {
    const win = alive(windows.login);
    const url = win?.webContents.getURL();
    return url ? [{ id: 1, url, title: win.webContents.getTitle() || url }] : [];
  });
}

module.exports = { getConsoleLogs: () => consoleLogs, fillCredentials, register };
