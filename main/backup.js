'use strict';
// Files a full backup carries besides the app data (renderer/app/backup.js): the files requests and
// environments point at — gRPC .proto files with the .proto files they import, CA / client certificates
// and keys — so a restore on another computer still works. Restoring never overwrites anything: a file
// whose original path is missing here is written under <userData>/restored-files/ instead, and the
// renderer points the restored requests at that copy.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 25 * 1024 * 1024; // the backup is one JSON file, read back with a 50 MB limit
const IMPORT = /^\s*import\s+(?:public\s+|weak\s+)?["']([^"']+)["']\s*;/gm;

// paths: [file]; protos: [{ file, includeDirs: [dir] }] (each proto's imports are followed, except the
// google/protobuf well-known types, which the gRPC loader has built in).
// → { files: { [absolutePath]: base64 }, missing: [path], skipped: [path (too large)] }
function readFiles({ paths = [], protos = [] } = {}) {
  const files = {}, missing = [], skipped = [];
  let total = 0;
  const add = (file) => {
    if (!file || files[file] !== undefined || missing.includes(file) || skipped.includes(file)) return files[file] !== undefined;
    let st;
    try { st = fs.statSync(file); } catch { missing.push(file); return false; }
    if (!st.isFile() || st.size > MAX_FILE || total + st.size > MAX_TOTAL) { skipped.push(file); return false; }
    files[file] = fs.readFileSync(file).toString('base64');
    total += st.size;
    return true;
  };
  for (const p of paths) add(p);
  for (const { file, includeDirs = [] } of protos) {
    const queue = [file];
    while (queue.length) {
      const f = queue.shift();
      if (!add(f)) continue;
      const text = Buffer.from(files[f], 'base64').toString('utf8');
      for (const [, imp] of text.matchAll(IMPORT)) {
        if (imp.startsWith('google/protobuf/')) continue;
        const found = [path.dirname(f), ...includeDirs].map((d) => path.resolve(d, imp)).find((c) => fs.existsSync(c));
        if (found && files[found] === undefined) queue.push(found);
      }
    }
  }
  return { files, missing, skipped };
}

// A path inside <userData>/restored-files for an original absolute path (drive letters and .. dropped).
function restoredPath(original) {
  const parts = String(original).replace(/^[A-Za-z]:/, '').split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..');
  return path.join(app.getPath('userData'), 'restored-files', ...parts);
}

// files: { [originalPath]: base64 } → { moved: { [originalPath]: newPath }, root: the restored-files folder }.
// Only files missing at their original path are written (to restored-files); files already there are left alone.
function writeFiles(files = {}) {
  const moved = {};
  for (const [orig, b64] of Object.entries(files)) {
    if (path.isAbsolute(orig) && fs.existsSync(orig)) continue;
    const dest = restoredPath(orig);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(b64, 'base64'), { mode: 0o600 });
    moved[orig] = dest;
  }
  return { moved, root: path.join(app.getPath('userData'), 'restored-files') };
}

const guard = (fn) => (_e, arg) => { try { return { ok: true, ...fn(arg) }; } catch (err) { return { ok: false, error: err.message }; } };

function register(ipcMain) {
  ipcMain.handle('backup-read-files', guard(readFiles));
  ipcMain.handle('backup-write-files', guard(writeFiles));
}

module.exports = { readFiles, restoredPath, register };
