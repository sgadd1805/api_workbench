'use strict';
// Save/open dialogs for text files (collection export/import, responses), a plain file picker
// (certificates), and opening a response in its default app (PDFs and other binary bodies).
const { dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Save-dialog filter from the suggested file name's extension.
function filtersFor(name) {
  const ext = path.extname(name || '').slice(1).toLowerCase();
  return ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : [{ name: 'All files', extensions: ['*'] }];
}
const OPENABLE = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'html', 'txt', 'json', 'xml', 'csv']);
const contentOf = ({ content, base64 }) => (base64 != null ? Buffer.from(base64, 'base64') : content);

const MAX_BYTES = 50 * 1024 * 1024;

function register(ipcMain) {
  // base64 instead of content saves binary data as-is.
  ipcMain.handle('save-text-file', async (_e, { defaultName, content, base64 }) => {
    const { filePath, canceled } = await dialog.showSaveDialog({ defaultPath: defaultName, filters: filtersFor(defaultName) });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try { fs.writeFileSync(filePath, contentOf({ content, base64 })); return { ok: true, filePath }; } catch (err) { return { ok: false, error: err.message }; }
  });
  // A project's api-client.json by path (only that file name). → { exists, content, mtimeMs }
  ipcMain.handle('read-text-file', async (_e, filePath) => {
    if (path.basename(String(filePath || '')) !== 'api-client.json') return { ok: false, error: 'Only api-client.json can be read this way' };
    try {
      const st = fs.statSync(filePath);
      if (st.size > MAX_BYTES) return { ok: false, error: 'File is larger than 50 MB' };
      return { ok: true, exists: true, content: fs.readFileSync(filePath, 'utf8'), mtimeMs: st.mtimeMs };
    } catch (err) { return err.code === 'ENOENT' ? { ok: true, exists: false } : { ok: false, error: err.message }; }
  });
  ipcMain.handle('open-in-default-app', async (_e, { name, content, base64 }) => {
    // Only document / image types: a response must never be opened as something executable (.app, .exe, .command, .sh …).
    const ext = path.extname(String(name || '')).slice(1).toLowerCase();
    if (!OPENABLE.has(ext)) return { ok: false, error: `Won't open .${ext || '(none)'} files directly — use Save… instead` };
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-workbench-'));
      const filePath = path.join(dir, path.basename(name));
      fs.writeFileSync(filePath, contentOf({ content, base64 }));
      const error = await shell.openPath(filePath);
      return error ? { ok: false, error } : { ok: true, filePath };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('pick-file', async (_e, { title, filters } = {}) => {
    const { filePaths, canceled } = await dialog.showOpenDialog({ title, properties: ['openFile'], filters: filters || [{ name: 'All files', extensions: ['*'] }] });
    return canceled ? null : filePaths[0];
  });
  ipcMain.handle('open-text-file', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }] });
    if (canceled || !filePaths[0]) return { ok: false, canceled: true };
    try {
      if (fs.statSync(filePaths[0]).size > MAX_BYTES) return { ok: false, error: 'File is larger than 50 MB' };
      return { ok: true, filePath: filePaths[0], content: fs.readFileSync(filePaths[0], 'utf8') };
    } catch (err) { return { ok: false, error: err.message }; }
  });
}

module.exports = { register };
