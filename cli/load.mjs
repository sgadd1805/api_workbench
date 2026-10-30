// Where a command-line run's project comes from (the app's db.json, or an api-client.json applied into an
// in-memory DB), and resolving the project, environment, scope, variables and data rows it runs with.
// Nothing here writes to the app's data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DB, normalizeDB, addEnv, activeEnv, uid, findReq, NETWORK_DEFAULTS } from '../renderer/app/store.js';
import { applyConfig, linkOperations, CONFIG_FILE } from '../renderer/app/config.js';
import { cacheSpec, specAnalysis } from '../renderer/app/openapi/registry.js';
import { validateSchema } from '../renderer/app/openapi/schema.js';
import { forgetTokens } from '../renderer/app/tokens.js';
import { parseCsv, requestsInScope } from '../renderer/app/runner.js';

const require = createRequire(import.meta.url);
const { openSecrets, hasSealed } = require('../main/secrets.js');

// Bad input or setup (missing data, unknown names): exit code 2.
export class SetupError extends Error {}

export const VAR_PREFIX = 'AW_VAR_';

// The app's user-data folder (Electron's userData for "api-workbench").
export function defaultDataDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'api-workbench');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'api-workbench');
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'api-workbench');
}

export function resetDB() {
  Object.assign(DB, { projects: [], features: [], notes: [], tokenSources: [], settings: { sidebarWidth: 240, openTabs: [], activeTab: null } });
  normalizeDB(DB);
  forgetTokens();
}

// db.json → DB. → warnings
export function loadDataDir(dir) {
  const file = path.join(dir, 'db.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    throw new SetupError(`No API Workbench data in ${dir} (no db.json). Point --data at the app's data folder, or use --config <${CONFIG_FILE}>.`);
  }
  let data;
  try { data = JSON.parse(text); } catch (err) { throw new SetupError(`${file} is not valid JSON: ${err.message}`); }
  const db = data?.db || data;
  if (!db || !Array.isArray(db.projects)) throw new SetupError(`${file} has no projects`);
  const warnings = [];
  // Secrets the app sealed with the operating system's protection (main/vault.js: DPAPI / Keychain /
  // libsecret) only open inside the app; a command-line run gets them from --var or the environment.
  if (hasSealed(db)) {
    const n = openSecrets(db, () => { throw new Error('sealed'); });
    warnings.push(`${n} secret value(s) in db.json are encrypted by the app (Settings → Privacy → Encrypt secrets) and can't be read here: pass the ones this run needs with --var <name>=<value> or ${VAR_PREFIX}<name>`);
  }
  Object.assign(DB, db);
  normalizeDB(DB);
  return warnings;
}

let schema;
async function schemaIssues(cfg) {
  try {
    schema ||= (await import('../docs/api-client.schema.json', { with: { type: 'json' } })).default;
    return validateSchema(schema, cfg, { root: schema }).map((e) => `${e.path || '(top level)'} ${e.message}`);
  } catch { return []; }
}

// Applies an api-client.json (as the app's "Apply api-client.json" does), attaching its specs in memory.
// → { project, warnings }
export async function loadConfigFile(file) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    throw new SetupError(err.code === 'ENOENT' ? `${file} not found` : `${file} is not valid JSON: ${err.message}`);
  }
  const warnings = (await schemaIssues(cfg)).map((i) => `${path.basename(file)}: ${i}`);
  let res;
  try { res = applyConfig(cfg, { codeFolder: path.dirname(path.resolve(file)) }); } catch (err) { throw new SetupError(err.message); }
  warnings.push(...res.warnings);
  const api = window.electronAPI;
  for (const location of res.specs) {
    const read = await api.specsRead(location);
    if (!read.ok) { warnings.push(`Spec ${location}: ${read.error}`); continue; }
    const id = uid();
    await api.specStoreSave(id, read.doc);
    cacheSpec(id, read.doc);
    res.project.specs.push({ id, title: read.title, version: read.version, specVersion: read.specVersion, operationCount: read.operationCount,
      source: { type: /^https?:/i.test(location) ? 'url' : 'file', location }, importedAt: Date.now() });
  }
  if (res.links.length) warnings.push(...linkOperations(res.project, res.links, specAnalysis));
  return { project: res.project, warnings };
}

// By exact name (or id), then ignoring case. what / where: for the message ('folder', ' in project "X"').
function byName(list, name, what, where = '', nameOf = (x) => x.name) {
  const hit = list.find((x) => nameOf(x) === name || x.id === name) || list.find((x) => nameOf(x).toLowerCase() === String(name).toLowerCase());
  if (hit) return hit;
  const names = list.map((x) => `"${nameOf(x)}"`).join(', ');
  throw new SetupError(`No ${what} "${name}"${where}. ${names ? `Available: ${names}` : `There are none.`}`);
}

export const findProject = (name) => byName(DB.projects, name, 'project');

// Makes the named environment (or the project's active one) the one the run uses. → env | null
export function useEnv(p, name) {
  if (name == null) return activeEnv(p);
  const env = byName(p.envs, name, 'environment', ` in project "${p.name}"`);
  p.activeEnv = env.id;
  return env;
}

// --var and AW_VAR_<name> values (--var wins), and network overrides, on the run's environment (created
// when the project has none). cwd: for relative certificate paths. → { env, warnings }
export function applyOverrides(p, env, { vars = [], network = {}, processEnv = process.env, cwd = process.cwd() } = {}) {
  const fromEnv = Object.entries(processEnv).filter(([k]) => k.startsWith(VAR_PREFIX) && k.length > VAR_PREFIX.length).map(([k, v]) => [k.slice(VAR_PREFIX.length), v]);
  const all = [...fromEnv, ...vars];
  const passphrase = processEnv.AW_PASSPHRASE;
  const net = { ...network };
  for (const k of ['caFile', 'certFile', 'keyFile', 'pfxFile']) if (net[k]) net[k] = path.resolve(cwd, net[k]);
  if (passphrase) net.passphrase = passphrase;
  if (!env && (all.length || Object.keys(net).length)) { env = addEnv(p, 'Default'); p.activeEnv = env.id; }
  for (const [k, v] of all) {
    const row = env.vars.find((x) => x.k === k);
    if (row) { row.v = v; row.on = true; } else env.vars.push({ k, v, on: true });
  }
  if (env) env.network = { ...NETWORK_DEFAULTS, ...env.network, ...net };
  const warnings = (env?.vars || []).filter((v) => v.secret && v.on && !v.v)
    .map((v) => `Secret variable "${v.k}" has no value in environment "${env.name}": set ${VAR_PREFIX}${v.k} or pass --var ${v.k}=…`);
  return { env, warnings };
}

// → { scope, label }
export function resolveScope(p, { folder = null, feature = null } = {}) {
  if (folder != null) { const f = byName(p.folders, folder, 'folder', ` in project "${p.name}"`); return { scope: { type: 'folder', id: f.id, projectId: p.id }, label: `${p.name} / ${f.name}` }; }
  if (feature != null) { const f = byName(DB.features, feature, 'feature group'); return { scope: { type: 'feature', id: f.id, projectId: p.id }, label: `${p.name} / ${f.name}` }; }
  return { scope: { type: 'project', id: p.id, projectId: p.id }, label: p.name };
}

// The requests to run, in order (a feature group's, limited to this project).
export function requestsFor(p, scope) {
  return requestsInScope(scope).filter((loc) => loc?.p === p && findReq(loc.r.id));
}

// CSV (first row = column names) or a JSON array of objects. → [{ column: value }]
export function readDataFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new SetupError(`Data file ${file} not found`); }
  let rows;
  if (/\.json$/i.test(file)) {
    try { rows = JSON.parse(text); } catch (err) { throw new SetupError(`Data file ${file} is not valid JSON: ${err.message}`); }
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new SetupError(`Data file ${file} must hold an array of objects`);
    rows = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
  } else rows = parseCsv(text);
  if (!rows.length) throw new SetupError(`No data rows in ${file} (a CSV's first row must be the column names)`);
  return rows;
}
