'use strict';
// Requests as files in a project's code folder, so a team versions and reviews them in git:
//   <dir>/project.yaml                         name, folder order, environments (no secret values)
//   <dir>/<folder>/<request>.request.yaml      one request each
// The renderer (renderer/app/repo.js) decides what goes in the files; this side writes YAML, removes
// request files that no longer exist, reads everything back, and watches the folder for changes
// (a git pull, a teammate's edit) so the app can offer to reload.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const REQUEST_EXT = '.request.yaml';
const HEADER = '# API Workbench request — edit in the app, or here (keep the id).\n';

function inside(dir, rel) {
  const full = path.resolve(dir, rel);
  if (full !== path.resolve(dir) && !full.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Refusing to write outside ${dir}: ${rel}`);
  return full;
}

function listRequestFiles(dir) {
  const out = [];
  (function walk(d, depth) {
    if (depth > 6) return;
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith(REQUEST_EXT)) out.push(full);
    }
  })(dir, 0);
  return out;
}

const dump = (data) => yaml.dump(data, { lineWidth: 120, noRefs: true, sortKeys: false });

// files: [{ rel, data }]; project: object for project.yaml. Unchanged files aren't rewritten
// (so git sees only real changes); request files no longer listed are deleted.
function writeCollection({ dir, project, files }) {
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set();
  let written = 0, removed = 0;
  const put = (full, text) => {
    keep.add(full);
    let old = null; try { old = fs.readFileSync(full, 'utf8'); } catch { /* new file */ }
    if (old === text) return;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    written++;
  };
  put(inside(dir, 'project.yaml'), '# API Workbench project — requests are in the *.request.yaml files beside this one.\n' + dump(project));
  for (const f of files) {
    if (!f.rel.endsWith(REQUEST_EXT)) throw new Error('Request files must end with ' + REQUEST_EXT);
    put(inside(dir, f.rel), HEADER + dump(f.data));
  }
  for (const full of listRequestFiles(dir)) if (!keep.has(full)) { fs.rmSync(full); removed++; }
  // Drop folders the removals left empty.
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) { const full = path.join(dir, d.name); try { if (!fs.readdirSync(full).length) fs.rmdirSync(full); } catch { /* not empty */ } }
  }
  return { written, removed, files: files.length };
}

function readCollection({ dir }) {
  if (!fs.existsSync(dir)) throw new Error(`${dir} doesn't exist`);
  let project = null;
  try { project = yaml.load(fs.readFileSync(path.join(dir, 'project.yaml'), 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw new Error('project.yaml: ' + err.message); }
  const requests = [], errors = [];
  for (const full of listRequestFiles(dir)) {
    const rel = path.relative(dir, full).split(path.sep).join('/');
    try { requests.push({ rel, data: yaml.load(fs.readFileSync(full, 'utf8')) }); } catch (err) { errors.push(`${rel}: ${err.message.split('\n')[0]}`); }
  }
  return { project, requests, errors };
}

// One watcher per folder; events are debounced and ignore our own writes for a moment.
const watchers = new Map(); // dir → { watcher, timer, quietUntil }
function watch(dir, onChange) {
  if (watchers.has(dir)) return;
  try {
    const w = { quietUntil: 0, timer: null };
    w.watcher = fs.watch(dir, { recursive: true }, (_type, file) => {
      if (Date.now() < w.quietUntil || (file && !/\.ya?ml$/.test(file))) return;
      clearTimeout(w.timer); w.timer = setTimeout(() => onChange(dir), 400);
    });
    watchers.set(dir, w);
  } catch { /* folder missing or recursive watch unsupported: no live reload */ }
}
const quiet = (dir, ms = 1500) => { const w = watchers.get(dir); if (w) w.quietUntil = Date.now() + ms; };
function unwatch(dir) { const w = watchers.get(dir); if (w) { w.watcher.close(); clearTimeout(w.timer); watchers.delete(dir); } }

function register(ipcMain) {
  const { windows, alive } = require('./windows');
  const guard = (fn) => async (_e, arg) => { try { return { ok: true, ...(await fn(arg)) }; } catch (err) { return { ok: false, error: err.message }; } };
  ipcMain.handle('repo-write', guard((arg) => { quiet(arg.dir); return writeCollection(arg); }));
  ipcMain.handle('repo-read', guard(readCollection));
  ipcMain.handle('repo-watch', guard(({ dir, on }) => {
    if (on) watch(dir, (d) => alive(windows.main)?.webContents.send('repo-changed', d)); else unwatch(dir);
    return {};
  }));
}

module.exports = { writeCollection, readCollection, listRequestFiles, register, REQUEST_EXT };
