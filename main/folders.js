'use strict';
// Folder picker and the recursive folder compare behind the Tools window's Diff → Folder mode.
const { dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const SKIP = new Set(['node_modules', '.git']);
const MAX_SIZE = 500 * 1024;

// Map of 'relative/path' → absolute path for every file under dir.
function walk(dir, base = '') {
  const out = {};
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory() && !SKIP.has(e.name)) Object.assign(out, walk(path.join(dir, e.name), rel));
    else if (e.isFile()) out[rel] = path.join(dir, e.name);
  }
  return out;
}

function compareFile(rel, fileA, fileB) {
  const stA = fs.statSync(fileA), stB = fs.statSync(fileB);
  if (stA.size > MAX_SIZE || stB.size > MAX_SIZE) {
    return stA.size === stB.size ? null : { path: rel, a: null, b: null, tooLarge: true };
  }
  const bA = fs.readFileSync(fileA), bB = fs.readFileSync(fileB);
  if (bA.equals(bB)) return null;
  if (bA.includes(0) || bB.includes(0)) return { path: rel, a: null, b: null, binary: true };
  return { path: rel, a: bA.toString('utf8'), b: bB.toString('utf8') };
}

function compareFolders(pathA, pathB) {
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  if (!pathA || !isDir(pathA)) return { ok: false, error: `Folder A not found: ${pathA || '(empty)'}` };
  if (!pathB || !isDir(pathB)) return { ok: false, error: `Folder B not found: ${pathB || '(empty)'}` };
  try {
    const filesA = walk(pathA), filesB = walk(pathB);
    const keys = [...new Set([...Object.keys(filesA), ...Object.keys(filesB)])].sort();
    const onlyA = [], onlyB = [], modified = [], unchanged = [];
    for (const k of keys) {
      if (!(k in filesB)) { onlyA.push(k); continue; }
      if (!(k in filesA)) { onlyB.push(k); continue; }
      const diff = compareFile(k, filesA[k], filesB[k]);
      if (diff) modified.push(diff); else unchanged.push(k);
    }
    return { ok: true, onlyA, onlyB, modified, unchanged };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function register(ipcMain) {
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('compare-folders', (_e, { pathA, pathB }) => compareFolders(pathA, pathB));
}

module.exports = { compareFolders, register };
