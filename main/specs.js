'use strict';
// OpenAPI / Swagger documents: find them in a project folder, read them from a file or URL
// (JSON or YAML, with external $refs pulled in), and store them in userData/specs/<id>.json —
// outside db.json, since specs can be megabytes and db.json is rewritten on every edit.
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'target', 'build', 'dist', 'out', '.gradle', '.idea', '.vscode',
  'vendor', 'venv', '.venv', '__pycache__', 'coverage', 'bin', 'obj', '.next', '.nuxt', 'tmp', '.cache']);
const SPEC_EXT = /\.(json|ya?ml)$/i;
const MAX_DEPTH = 10, MAX_FILES = 50000, MAX_SPEC_BYTES = 20 * 1024 * 1024, SNIFF_BYTES = 4096;

// ---- parsing
function parseText(text, hint = '') {
  const t = text.replace(/^﻿/, '');
  if (/\.json$/i.test(hint) || /^\s*[{[]/.test(t)) {
    try { return JSON.parse(t); } catch (err) { if (/\.json$/i.test(hint)) throw new Error(`Invalid JSON: ${err.message}`); }
  }
  return yaml.load(t, { json: true });
}

const specVersion = (doc) => (doc && typeof doc === 'object' ? (doc.openapi ? `OpenAPI ${doc.openapi}` : doc.swagger ? `Swagger ${doc.swagger}` : null) : null);
const summarize = (doc) => ({
  specVersion: specVersion(doc),
  title: doc?.info?.title || 'Untitled API',
  version: doc?.info?.version || '',
  operationCount: Object.values(doc?.paths || {}).reduce((n, item) => n + Object.keys(item || {}).filter((k) => /^(get|put|post|delete|options|head|patch|trace)$/.test(k)).length, 0),
});

// ---- external $ref bundling
// Local refs ('#/components/…') stay as refs (the validator resolves them lazily, which also handles
// recursive schemas). Refs to other files/URLs are inlined, with their own local refs resolved against
// that document; a cycle back into a document being inlined becomes {} (any value).
const pointerGet = (doc, pointer) => pointer.replace(/^#\/?/, '').split('/').filter(Boolean)
  .map((s) => decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~')).reduce((o, k) => (o == null ? undefined : o[k]), doc);

async function bundle(root, base, loader) {
  const cache = new Map(); // absolute location → parsed doc
  const load = async (loc) => { if (!cache.has(loc)) cache.set(loc, await loader(loc)); return cache.get(loc); };
  const resolveLoc = (ref, from) => (/^https?:/i.test(from) ? new URL(ref, from).href : /^https?:/i.test(ref) ? ref : path.resolve(path.dirname(from), ref));

  async function walk(node, docLoc, doc, isRoot, stack) {
    if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) node[i] = await walk(node[i], docLoc, doc, isRoot, stack); return node; }
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string') {
      const [file, pointer = ''] = node.$ref.split('#');
      if (!file && isRoot) return node; // local ref in the root document: keep
      const loc = file ? resolveLoc(file, docLoc) : docLoc;
      const key = loc + '#' + pointer;
      if (stack.has(key)) return {};
      const target = file ? await load(loc) : doc;
      const value = pointerGet(target, '#' + pointer);
      if (value === undefined) throw new Error(`Cannot resolve $ref "${node.$ref}" in ${docLoc}`);
      stack.add(key);
      const copy = await walk(structuredClone(value), loc, target, false, stack);
      stack.delete(key);
      return copy;
    }
    for (const k of Object.keys(node)) node[k] = await walk(node[k], docLoc, doc, isRoot, stack);
    return node;
  }
  return walk(root, base, root, true, new Set());
}

const fileLoader = async (loc) => parseText(fs.readFileSync(loc, 'utf8'), loc);
const urlLoader = async (loc) => {
  const res = await fetch(loc, { headers: { Accept: 'application/json, application/yaml, text/yaml, */*' } });
  if (!res.ok) throw new Error(`${loc}: HTTP ${res.status}`);
  return parseText(await res.text(), new URL(loc).pathname);
};
const loaderFor = (loc) => (/^https?:/i.test(loc) ? urlLoader : fileLoader);

async function readSpec(loc) {
  const loader = loaderFor(loc);
  if (loader === fileLoader && fs.statSync(loc).size > MAX_SPEC_BYTES) throw new Error('File is larger than 20 MB');
  const doc = await loader(loc);
  if (!specVersion(doc)) throw new Error('Not an OpenAPI/Swagger document (no "openapi" or "swagger" field)');
  return { doc: await bundle(doc, loc, loader), ...summarize(doc) };
}

// ---- finding specs in a folder
function looksLikeSpec(file) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, SNIFF_BYTES, 0));
    fs.closeSync(fd);
  } catch { return false; }
  return /"(openapi|swagger)"\s*:\s*"\d/.test(head) || /^\s*["']?(openapi|swagger)["']?\s*:\s*["']?\d/m.test(head);
}

function findSpecFiles(folder) {
  const found = [];
  let seen = 0;
  (function walk(dir, depth) {
    if (depth > MAX_DEPTH || seen > MAX_FILES) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1); continue; }
      if (!e.isFile() || !SPEC_EXT.test(e.name) || ++seen > MAX_FILES) continue;
      if (looksLikeSpec(full)) found.push(full);
    }
  })(folder, 0);
  return found;
}

async function findSpecs(folder) {
  const results = [];
  for (const file of findSpecFiles(folder)) {
    try {
      const doc = parseText(fs.readFileSync(file, 'utf8'), file);
      if (specVersion(doc)) results.push({ path: file, rel: path.relative(folder, file), ...summarize(doc) });
    } catch (err) {
      results.push({ path: file, rel: path.relative(folder, file), error: err.message });
    }
  }
  return results;
}

// ---- storage
// Electron is required where it's used, so the parsing and reading above also work in plain Node (cli/).
const storeDir = () => path.join(require('electron').app.getPath('userData'), 'specs');
const storeFile = (id) => path.join(storeDir(), String(id).replace(/[^\w-]/g, '') + '.json');

const guard = (fn) => async (...args) => { try { return { ok: true, ...(await fn(...args)) }; } catch (err) { return { ok: false, error: err.message }; } };

function register(ipcMain) {
  ipcMain.handle('specs-find', guard(async (_e, folder) => ({ specs: await findSpecs(folder) })));
  ipcMain.handle('specs-read', guard((_e, loc) => readSpec(loc)));
  ipcMain.handle('specs-pick-file', async () => {
    const r = await require('electron').dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'OpenAPI / Swagger', extensions: ['json', 'yaml', 'yml'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('spec-store-save', guard((_e, { id, doc }) => {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(storeFile(id), JSON.stringify(doc));
    return {};
  }));
  ipcMain.handle('spec-store-load', guard((_e, id) => ({ doc: JSON.parse(fs.readFileSync(storeFile(id), 'utf8')) })));
  // A spec's text from elsewhere (e.g. an older git version) → the parsed document.
  ipcMain.handle('specs-parse', guard((_e, { text, name }) => {
    const doc = parseText(text, name);
    if (!specVersion(doc)) throw new Error('Not an OpenAPI/Swagger document');
    return { doc };
  }));
  ipcMain.handle('spec-store-delete', guard((_e, id) => { fs.rmSync(storeFile(id), { force: true }); return {}; }));
}

module.exports = { parseText, bundle, readSpec, findSpecs, register };
