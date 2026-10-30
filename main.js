'use strict';
// Electron entry point: app lifecycle plus IPC registration. Each main/*.js module owns one
// feature area and registers its own ipcMain handlers (channel names mirror preload.js).
const { app, ipcMain, session } = require('electron');
const fs = require('fs');
const path = require('path');

// The app used to be called api-client-thick: move its data into the new user-data folder once,
// before any module reads from it. Entries already in the new folder are left alone.
(function moveLegacyData() {
  const from = path.join(app.getPath('appData'), 'api-client-thick'), to = app.getPath('userData');
  if (!fs.existsSync(from) || fs.existsSync(path.join(to, 'db.json'))) return;
  try {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) if (!fs.existsSync(path.join(to, name))) fs.renameSync(path.join(from, name), path.join(to, name));
    fs.rmdirSync(from); // only if now empty
  } catch { /* keep whatever couldn't be moved where it was */ }
})();

const { windows, openMainWindow, ICON } = require('./main/windows');
const { trustedIpc, harden } = require('./main/security');

// IPC handlers answer the app's own pages only (main/security.js).
const ipc = trustedIpc(ipcMain);

for (const mod of [
  require('./main/windows'),
  require('./main/storage'),
  require('./main/http'),
  require('./main/folders'),
  require('./main/har'),
  require('./main/login'),
  require('./main/accounts'),
  require('./main/claude'),
  require('./main/files'),
  require('./main/history'),
  require('./main/specs'),
  require('./main/git'),
  require('./main/terminal'),
  require('./main/logs'),
  require('./main/tasks'),
  require('./main/load'),
  require('./main/mock'),
  require('./main/proxy'),
  require('./main/protocols'),
  require('./main/repofiles'),
  require('./main/serverlogs'),
  require('./main/otel'),
  require('./main/backup'),
  require('./main/timings'),
  require('./main/mcp'),
]) mod.register(ipc);

// Windows groups taskbar buttons and pins by this id; without it they show as Electron.
if (process.platform === 'win32') app.setAppUserModelId('API Workbench');

app.whenReady().then(() => {
  harden(app, session);
  app.dock?.setIcon(ICON); // macOS: run from source, the dock would show Electron's icon
  openMainWindow();
  app.on('activate', () => {
    if (!windows.main) openMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
