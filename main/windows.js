'use strict';
// Window lifecycle. The main and Tools windows load bundled pages with the preload (electronAPI);
// the login window (main/login.js) loads arbitrary sites without it.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { webPreferences } = require('./security');
// The app icon (assets/logo.svg rendered at 512 px): window and taskbar icon on Windows / Linux, dock icon on macOS.
const ICON = path.join(ROOT, 'assets', 'icon.png');
const windows = { main: null, tools: null, notes: null, login: null, logs: new Map() }; // logs: source id → window
const alive = (w) => (w && !w.isDestroyed() ? w : null);

// App windows get the full electronAPI through the preload, so they must never
// navigate away from the bundled pages (e.g. a link or URL dropped on the window).
function lockDown(win) {
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function appWindow(file, options) {
  const win = new BrowserWindow({
    icon: ICON, ...options,
    webPreferences: webPreferences({ preload: path.join(ROOT, 'preload.js') }),
  });
  lockDown(win);
  win.loadFile(path.join(ROOT, file));
  return win;
}

function openMainWindow() {
  windows.main = appWindow('index.html', { width: 1320, height: 880 });
  // ⌘W / Ctrl+W closes the active request tab rather than the window; the page closes the
  // window itself when no tabs are open. preventDefault here also stops the menu accelerator.
  windows.main.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.meta || input.control) && !input.shift && !input.alt && input.key.toLowerCase() === 'w') {
      e.preventDefault();
      windows.main.webContents.send('shortcut', 'close-tab');
    }
  });
  // The main window is the app: closing it takes the (possibly hidden) login, tools and notes windows with it.
  windows.main.on('closed', () => {
    windows.main = null;
    for (const w of [windows.login, windows.tools, windows.notes, ...windows.logs.values()]) alive(w)?.destroy();
  });
}

function openToolsWindow() {
  if (alive(windows.tools)) return windows.tools.focus();
  windows.tools = appWindow('tools.html', { width: 860, height: 700, title: 'Tools' });
  windows.tools.on('closed', () => { windows.tools = null; });
}

// Popped-out Notes. The notes stay in the main window's DB; this window reads and edits them through
// messages relayed by notes-to-main / notes-to-window (renderer/notes/main.js, actions/notes.js).
let quitting = false; // closing every window on quit isn't the user closing Notes (it reopens next time)
function openNotesWindow() {
  if (alive(windows.notes)) return windows.notes.focus();
  windows.notes = appWindow('notes.html', { width: 820, height: 640, title: 'Notes' });
  windows.notes.on('closed', () => {
    windows.notes = null;
    if (!quitting) alive(windows.main)?.webContents.send('notes-msg', { type: 'window-closed' });
  });
}

// Log lines and task state go to the main window and every popped-out log window.
function broadcast(channel, payload) {
  for (const w of [windows.main, ...windows.logs.values()]) alive(w)?.webContents.send(channel, payload);
}

// Popped-out logs: one window per task / log source (logs.html?id=…). Like Notes, its settings live in
// the main window's DB, so the window asks the main window (logs-to-main / logs-to-window relay);
// lines and searches come straight from main/logs.js and main/serverlogs.js.
function openLogsWindow(id, title = 'Logs') {
  const open = alive(windows.logs.get(id));
  if (open) return open.focus();
  const win = new BrowserWindow({
    width: 1000, height: 720, title, icon: ICON,
    webPreferences: webPreferences({ preload: path.join(ROOT, 'preload.js') }),
  });
  lockDown(win);
  win.loadFile(path.join(ROOT, 'logs.html'), { query: { id } });
  windows.logs.set(id, win);
  win.on('closed', () => {
    if (windows.logs.get(id) === win) windows.logs.delete(id);
    if (!quitting) alive(windows.main)?.webContents.send('logs-msg', { type: 'window-closed', id });
  });
}

function register(ipcMain) {
  app.on('before-quit', () => { quitting = true; });
  ipcMain.handle('open-logs-window', (_e, { id, title }) => { openLogsWindow(id, title); return true; });
  ipcMain.handle('logs-to-main', (_e, msg) => { alive(windows.main)?.webContents.send('logs-msg', msg); return true; });
  ipcMain.handle('logs-to-window', (_e, { id, msg }) => { alive(windows.logs.get(id))?.webContents.send('logs-msg', msg); return !!alive(windows.logs.get(id)); });
  ipcMain.handle('logs-dock', (_e, id) => {
    alive(windows.main)?.webContents.send('logs-msg', { type: 'dock', id });
    alive(windows.logs.get(id))?.close();
    alive(windows.main)?.focus();
    return true;
  });
  ipcMain.handle('open-notes-window', () => { openNotesWindow(); return true; });
  ipcMain.handle('notes-to-main', (_e, msg) => { alive(windows.main)?.webContents.send('notes-msg', msg); return true; });
  ipcMain.handle('notes-to-window', (_e, msg) => { alive(windows.notes)?.webContents.send('notes-msg', msg); return !!alive(windows.notes); });
  // "Dock" in the Notes window: close it and show Notes in the main window's side panel.
  ipcMain.handle('notes-dock', () => {
    alive(windows.main)?.webContents.send('notes-msg', { type: 'dock' });
    alive(windows.notes)?.close();
    alive(windows.main)?.focus();
    return true;
  });
  ipcMain.handle('open-tools-window', () => { openToolsWindow(); return true; });
  // Hand a value to a tool: to the popped-out Tools window if it's open, else tell the caller to use
  // the side panel instead.
  ipcMain.handle('tools-send', (_e, payload) => {
    if (!alive(windows.tools)) return { target: 'panel' };
    windows.tools.webContents.send('tools-send', payload);
    windows.tools.focus();
    return { target: 'window' };
  });
  // "Dock" in the Tools window: close it and show Tools in the main window's side panel.
  ipcMain.handle('tools-dock', () => {
    alive(windows.tools)?.close();
    alive(windows.main)?.webContents.send('shortcut', 'dock-tools');
    alive(windows.main)?.focus();
    return true;
  });
}

module.exports = { windows, alive, broadcast, openMainWindow, register, ICON };
