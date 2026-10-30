// Full backup and selective restore of everything the app keeps: projects (environments, folders, requests,
// tasks, log sources …), features, notes, token sources and settings, plus what lives outside db.json —
// attached spec documents, Session test accounts, optionally History — and the files requests point at
// (.proto files and their imports, certificates and keys), read by main/backup.js.
//
// Backup file: { format: BACKUP_FORMAT, version: 1, createdAt, secrets: bool,
//   data: { projects, features, notes, tokenSources, settings }, specs: { [specId]: document },
//   accounts: [{ label, user, env, pass?, totp? }], history?: [entry], files: { [absolutePath]: base64 } }
// Without secrets, auth tokens and passwords, secret variables, cookie jars, certificate passphrases,
// secret-looking token source fields and account passwords are blanked (the shape stays complete).
import { DB, uid, normalizeProject, normalizeDB, allRequests, pruneFeatures, findReq } from './store.js';
import { stripSecrets } from './collection.js';
import { joinPath, relPath } from '../shared/paths.js';

export const BACKUP_FORMAT = 'api-workbench-backup';
// UI and window state that belongs to this computer's session, not to a backup.
const SESSION_SETTINGS = ['openTabs', 'activeTab', 'logWindows', 'notesWindow', 'termTabs', 'termActive', 'termHistory'];
const SECRET_FIELD = /(secret|password|passwd|token|api[-_]?key|assertion)/i;
const isVarRef = (s) => !s || /^\s*\{\{[^}]+\}\}\s*$/.test(s);

// A token source with literal secrets (client_secret=…, password fields, secret headers) blanked.
function stripSourceSecrets(t) {
  const blankRows = (list) => (list || []).forEach((r) => { if (SECRET_FIELD.test(r.k) && !isVarRef(r.v)) r.v = ''; });
  blankRows(t.headers); blankRows(t.body?.form);
  if (t.body?.text) t.body.text = t.body.text
    .replace(/((?:^|[&?\s])[\w.-]*(?:secret|password|passwd|token|api[-_]?key|assertion)[\w.-]*=)([^&\s]*)/gi, (m, k, v) => (isVarRef(v) ? m : k))
    .replace(/("[\w.-]*(?:secret|password|passwd|token|api[-_]?key|assertion)[\w.-]*"\s*:\s*)"((?:[^"\\]|\\.)*)"/gi, (m, k, v) => (isVarRef(v) ? m : `${k}""`));
  return t;
}

// What main/backup.js should read for these projects: certificate files and .proto files (with includes).
export function filesWanted(projects) {
  const paths = new Set(), protos = [];
  for (const p of projects) {
    for (const e of p.envs) for (const k of ['caFile', 'certFile', 'keyFile', 'pfxFile']) if (e.network?.[k]) paths.add(e.network[k]);
    for (const r of allRequests(p)) if (r.kind === 'grpc' && r.grpc?.protoFile) {
      protos.push({ file: r.grpc.protoFile, includeDirs: String(r.grpc.includeDirs || '').split(',').map((d) => d.trim()).filter(Boolean) });
    }
  }
  return { paths: [...paths], protos };
}

// → the backup object. specs / accounts / history / files are gathered by the caller (they live in main).
export function buildBackup({ specs = {}, accounts = [], history = null, files = {}, includeSecrets = false, now = Date.now() } = {}) {
  const data = structuredClone({ projects: DB.projects, features: DB.features, notes: DB.notes, tokenSources: DB.tokenSources, settings: DB.settings });
  for (const k of SESSION_SETTINGS) delete data.settings[k];
  if (!includeSecrets) {
    if (data.settings?.mcp) data.settings.mcp.token = '';
    for (const p of data.projects) { stripSecrets(p); p.cookies = ''; }
    data.tokenSources.forEach(stripSourceSecrets);
  }
  return {
    format: BACKUP_FORMAT, version: 1, createdAt: new Date(now).toISOString(), secrets: !!includeSecrets, data, specs,
    accounts: accounts.map((a) => ({ label: a.label, user: a.user, env: a.env || '', ...(includeSecrets && a.pass && { pass: a.pass }), ...(includeSecrets && a.totp && { totp: a.totp }) })),
    ...(history && { history }), files,
  };
}

// ---- Password protection: the whole backup encrypted with AES-256-GCM, its key derived from a password
// with PBKDF2-SHA256. File: { format, version: 1, encrypted: { cipher, kdf, iterations, salt, iv, data } }
// (base64). Wrong passwords and tampering both fail the GCM check, so nothing half-decrypted gets restored.
const ITERATIONS = 600000;
const b64 = (bytes) => { let s = ''; for (const c of new Uint8Array(bytes)) s += String.fromCharCode(c); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function keyFrom(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// backup object → the encrypted file's object. iterations: for tests only.
export async function encryptBackup(backup, password, { iterations = ITERATIONS } = {}) {
  if (!password) throw new Error('A password is needed');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(password, salt, iterations), new TextEncoder().encode(JSON.stringify(backup)));
  return { format: BACKUP_FORMAT, version: 1, createdAt: backup.createdAt, encrypted: { cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations, salt: b64(salt), iv: b64(iv), data: b64(data) } };
}

export const isEncryptedBackup = (text) => { try { const b = JSON.parse(text); return b?.format === BACKUP_FORMAT && !!b.encrypted; } catch { return false; } };

// Encrypted file text → the backup's JSON text. Throws 'Wrong password' (or a damaged file).
export async function decryptBackup(text, password) {
  const e = JSON.parse(text).encrypted;
  if (e?.cipher !== 'AES-256-GCM' || e.kdf !== 'PBKDF2-SHA256') throw new Error('This backup uses an encryption this app doesn\'t know');
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv) }, await keyFrom(password, unb64(e.salt), e.iterations), unb64(e.data));
    return new TextDecoder().decode(plain);
  } catch { throw new Error('Wrong password, or the backup file is damaged'); }
}

// text → backup object (throws on anything else)
export function parseBackup(text) {
  let b;
  try { b = JSON.parse(text); } catch { throw new Error('Not a JSON file'); }
  if (b?.format !== BACKUP_FORMAT || !b.data || !Array.isArray(b.data.projects)) throw new Error('Not an API Workbench backup (use Import → Collection file for a single exported project)');
  if (b.version !== 1) throw new Error(`Backup version ${b.version} is newer than this app understands`);
  return b;
}

// What's in a backup, for the restore dialog.
export function backupContents(b) {
  const d = b.data;
  return {
    createdAt: b.createdAt, secrets: !!b.secrets,
    projects: d.projects.map((p) => ({ id: p.id, name: p.name, requests: allRequests(normalizeProject(structuredClone(p))).length, exists: DB.projects.some((x) => x.name === p.name) })),
    tokenSources: (d.tokenSources || []).length, notes: (d.notes || []).length, features: (d.features || []).length,
    settings: !!d.settings, accounts: (b.accounts || []).length, history: (b.history || []).length, files: Object.keys(b.files || {}).length,
  };
}

// The path main/backup.js writes a file to when its original location is missing (see restoredPath there).
export const restoredPathFor = (root, original) => joinPath(root, String(original).replace(/^[A-Za-z]:/, '').split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..').join('/'));

// Points a restored project at restored copies of files that were missing here. moved: { original → copy };
// include folders follow when any restored file lies inside them.
function relinkFiles(p, moved, root) {
  const origs = Object.keys(moved);
  if (!origs.length) return;
  const dir = (d) => (root && origs.some((o) => relPath(d, o) !== o) ? restoredPathFor(root, d) : d);
  for (const e of p.envs) for (const k of ['caFile', 'certFile', 'keyFile', 'pfxFile']) if (moved[e.network?.[k]]) e.network[k] = moved[e.network[k]];
  for (const r of allRequests(p)) if (r.grpc) {
    if (moved[r.grpc.protoFile]) r.grpc.protoFile = moved[r.grpc.protoFile];
    if (r.grpc.includeDirs) r.grpc.includeDirs = r.grpc.includeDirs.split(',').map((d) => d.trim()).filter(Boolean).map(dir).join(', ');
  }
}

// Restores the chosen parts of backup b into DB. Every restored project gets fresh ids (so it can sit beside
// the one it came from); references follow (active environment, spec links, token sources, features, notes).
// pick: { projects: [backup project id], sameName: 'replace' | 'keep', tokenSources, notes, features, settings }
// files: { moved, root } from main/backup.js writeFiles.
// → { summary: { [what]: n }, specDocs: [{ id, doc }] (to store), idMap (old request id → new) }
export function restoreBackup(b, pick, { moved = {}, root = '' } = {}) {
  const d = structuredClone(b.data), summary = {}, specDocs = [], idMap = new Map();
  const count = (k, n = 1) => { if (n) summary[k] = (summary[k] || 0) + n; };

  // Token sources: matched by name. The restored ones are always available to restored requests.
  const sourceMap = new Map();
  for (const t of d.tokenSources || []) {
    const have = DB.tokenSources.find((x) => x.name === t.name);
    if (have && pick.tokenSources) { Object.assign(have, { ...t, id: have.id }); sourceMap.set(t.id, have.id); count('token sources'); }
    else if (have) sourceMap.set(t.id, have.id);
    else if (pick.tokenSources || d.projects.some((p) => pick.projects.includes(p.id) && usesSource(p, t.id))) {
      const copy = { ...t, id: uid() }; DB.tokenSources.push(copy); sourceMap.set(t.id, copy.id); count('token sources');
    }
  }

  const projectMap = new Map();
  for (const src of d.projects.filter((p) => pick.projects.includes(p.id))) {
    const p = normalizeProject(src), oldId = p.id;
    p.id = uid();
    const envIds = new Map(p.envs.map((e) => [e.id, (e.id = uid())]));
    p.activeEnv = envIds.get(p.activeEnv) ?? p.envs[0]?.id ?? null;
    for (const f of p.folders) f.id = uid();
    const specIds = new Map(p.specs.map((s) => [s.id, (s.id = uid())]));
    for (const [oldSpec, newSpec] of specIds) if (b.specs?.[oldSpec]) specDocs.push({ id: newSpec, doc: b.specs[oldSpec] });
    const fixAuth = (a) => { if (a?.type === 'token') a.sourceId = sourceMap.get(a.sourceId) || a.sourceId; };
    fixAuth(p.auth); p.folders.forEach((f) => fixAuth(f.auth));
    for (const r of allRequests(p)) {
      const nid = uid(); idMap.set(r.id, nid); r.id = nid;
      fixAuth(r.auth);
      if (r.spec?.specId) r.spec.specId = specIds.get(r.spec.specId) || r.spec.specId;
    }
    for (const t of p.tasks) t.id = uid();
    for (const s of p.logSources) s.id = uid();
    delete p.configHash;
    relinkFiles(p, moved, root);

    const existing = DB.projects.find((x) => x.name === p.name);
    if (existing && pick.sameName === 'replace') {
      DB.projects = DB.projects.filter((x) => x !== existing);
      for (const n of DB.notes) if (n.projectId === existing.id) n.projectId = p.id; // the old project's notes stay
      count('projects replaced');
    } else {
      if (existing) p.name = uniqueName(p.name);
      count('projects');
    }
    DB.projects.push(p);
    projectMap.set(oldId, p.id);
    count('requests', allRequests(p).length);
  }
  pruneFeatures();

  if (pick.features) for (const f of d.features || []) {
    const ids = f.requestIds.map((id) => idMap.get(id)).filter(Boolean);
    if (!ids.length && f.requestIds.length) continue; // only about projects that weren't restored
    const have = DB.features.find((x) => x.name === f.name);
    if (have) { for (const id of ids) if (!have.requestIds.includes(id)) have.requestIds.push(id); }
    else { DB.features.push({ ...f, id: uid(), requestIds: ids }); count('features'); }
  }
  if (pick.notes) for (const n of d.notes || []) {
    if (n.projectId && !projectMap.has(n.projectId)) continue;
    const projectId = n.projectId ? projectMap.get(n.projectId) : null;
    if (DB.notes.some((x) => x.title === n.title && x.body === n.body && x.projectId === projectId)) continue;
    DB.notes.push({ ...n, id: uid(), projectId }); count('notes');
  }
  if (pick.settings && d.settings) {
    const keep = Object.fromEntries(SESSION_SETTINGS.filter((k) => k in DB.settings).map((k) => [k, DB.settings[k]]));
    DB.settings = { ...d.settings, ...keep };
    count('app settings');
  }
  normalizeDB(DB);
  return { summary, specDocs, idMap };
}

const usesSource = (p, sourceId) => [p.auth, ...p.folders.map((f) => f.auth), ...p.folders.flatMap((f) => f.requests.map((r) => r.auth)), ...p.requests.map((r) => r.auth)].some((a) => a?.type === 'token' && a.sourceId === sourceId);
function uniqueName(name) {
  for (let i = 1; ; i++) { const n = `${name} (restored${i > 1 ? ` ${i}` : ''})`; if (!DB.projects.some((p) => p.name === n)) return n; }
}

// History entries from a backup that aren't here yet, oldest first (History appends put the newest on top),
// with request ids pointing at the restored requests.
export function historyToRestore(b, idMap, current = []) {
  const have = new Set(current.map((e) => e.id));
  return (b.history || []).filter((e) => !have.has(e.id)).map((e) => ({ ...e, reqId: idMap.get(e.reqId) || (findReq(e.reqId) ? e.reqId : null) })).reverse();
}
