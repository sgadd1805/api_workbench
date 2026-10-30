// Project ⇄ file: this app's own JSON format, and Postman Collection v2.1 (import also reads v2.0).
import { uid, normalizeProject, newReq } from './store.js';

export const NATIVE_FORMAT = 'api-workbench-collection';
const LEGACY_FORMAT = 'thick-client-collection'; // exports from before the app was renamed
const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

// Exports leave out the cookie jar (session state), attached specs (their documents live outside db.json)
// and the code folder (a path on this machine). Unless includeSecrets, auth tokens and passwords,
// secret variables and certificate passphrases are blanked too.
export function stripSecrets(p) {
  const blank = (a) => { if (a) { if (a.token) a.token = ''; if (a.pass) a.pass = ''; } };
  blank(p.auth);
  for (const f of p.folders) { blank(f.auth); f.requests.forEach((r) => blank(r.auth)); }
  p.requests.forEach((r) => blank(r.auth));
  for (const e of p.envs) { for (const v of e.vars) if (v.secret) v.v = ''; if (e.network?.passphrase) e.network.passphrase = ''; }
  return p;
}
const shareable = (p, includeSecrets) => {
  const copy = { ...structuredClone(p), cookies: '', specs: [], codeFolder: '' };
  return includeSecrets ? copy : stripSecrets(copy);
};

export function exportNative(p, { includeSecrets = false } = {}) {
  return JSON.stringify({ format: NATIVE_FORMAT, version: 1, project: shareable(p, includeSecrets) }, null, 2);
}

// ---- Postman export
const pmKv = (rows) => rows.filter((r) => r.k).map((r) => ({ key: r.k, value: r.v, ...(r.on ? {} : { disabled: true }) }));

function pmAuth(auth) {
  if (!auth || auth.type === 'inherit') return undefined;
  if (auth.type === 'bearer') return { type: 'bearer', bearer: [{ key: 'token', value: auth.token || '', type: 'string' }] };
  if (auth.type === 'basic') return { type: 'basic', basic: [{ key: 'username', value: auth.user || '', type: 'string' }, { key: 'password', value: auth.pass || '', type: 'string' }] };
  return { type: 'noauth' };
}

function pmBody(body) {
  if (body.type === 'form') return { mode: 'urlencoded', urlencoded: pmKv(body.form) };
  if (body.type === 'json') return { mode: 'raw', raw: body.text, options: { raw: { language: 'json' } } };
  if (body.type === 'raw') return { mode: 'raw', raw: body.text };
  return undefined;
}

const pmItem = (r) => ({
  name: r.name,
  request: { method: r.method, header: pmKv(r.headers), url: r.url, body: pmBody(r.body), auth: pmAuth(r.auth) },
});

export function exportPostman(source, { includeSecrets = false } = {}) {
  const p = includeSecrets ? source : stripSecrets(structuredClone(source));
  const env = p.envs.find((e) => e.id === p.activeEnv);
  return JSON.stringify({
    info: { name: p.name, schema: POSTMAN_SCHEMA },
    auth: pmAuth(p.auth),
    variable: env ? pmKv(env.vars) : [],
    item: [...p.folders.map((f) => ({ name: f.name, auth: pmAuth(f.auth), item: f.requests.map(pmItem) })), ...p.requests.map(pmItem)],
  }, null, 2);
}

// ---- Import (either format) → a new, normalized project with fresh ids
export function importCollection(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Not a JSON file'); }
  if ((data?.format === NATIVE_FORMAT || data?.format === LEGACY_FORMAT) && data.project) return reId(normalizeProject(data.project));
  if (Array.isArray(data?.item) && data.info) return fromPostman(data);
  throw new Error('Unrecognised collection format (expected this app\'s export or a Postman v2 collection)');
}

function reId(p) {
  p.id = uid();
  const envIds = new Map(p.envs.map((e) => [e.id, (e.id = uid())]));
  p.activeEnv = envIds.get(p.activeEnv) ?? p.envs[0]?.id ?? null;
  for (const f of p.folders) f.id = uid();
  for (const r of [...p.requests, ...p.folders.flatMap((f) => f.requests)]) r.id = uid();
  return p;
}

const rowsFromPm = (list) => (list || []).map((x) => ({ k: x.key ?? '', v: x.value ?? '', on: !x.disabled }));

// Postman v2.1 auth params are [{key, value}]; v2.0 used an object.
const pmParam = (params, key) => (Array.isArray(params) ? params.find((x) => x.key === key)?.value : params?.[key]) ?? '';

function authFromPm(auth, fallback) {
  if (!auth) return fallback;
  if (auth.type === 'bearer') return { type: 'bearer', token: pmParam(auth.bearer, 'token') };
  if (auth.type === 'basic') return { type: 'basic', user: pmParam(auth.basic, 'username'), pass: pmParam(auth.basic, 'password') };
  if (auth.type === 'noauth') return { type: 'none' };
  return fallback; // unsupported types (oauth2, apikey, …) fall back to inheriting
}

function bodyFromPm(body) {
  if (!body || body.disabled) return { type: 'none', text: '', form: [] };
  if (body.mode === 'urlencoded') return { type: 'form', text: '', form: rowsFromPm(body.urlencoded) };
  if (body.mode === 'raw') return { type: body.options?.raw?.language === 'json' ? 'json' : 'raw', text: body.raw || '', form: [] };
  if (body.mode === 'graphql') return { type: 'json', text: JSON.stringify(body.graphql || {}), form: [] };
  return { type: 'none', text: '', form: [] };
}

function requestFromPm(item) {
  const req = typeof item.request === 'string' ? { url: item.request } : item.request || {};
  const url = typeof req.url === 'string' ? req.url : req.url?.raw || '';
  return newReq({
    name: item.name || url || 'Imported',
    method: (req.method || 'GET').toUpperCase(),
    url,
    headers: rowsFromPm(Array.isArray(req.header) ? req.header : []),
    body: bodyFromPm(req.body),
    auth: authFromPm(req.auth, { type: 'inherit' }),
  });
}

// Our model has one folder level, so nested Postman folders become "Parent / Child" folders.
function fromPostman(data) {
  const p = normalizeProject({ id: uid(), name: data.info.name || 'Imported collection', auth: authFromPm(data.auth, { type: 'none' }) });
  const walk = (items, folderPath, folderAuth) => {
    for (const item of items) {
      if (Array.isArray(item.item)) {
        const name = [...folderPath, item.name || 'Folder'];
        const auth = authFromPm(item.auth, { type: 'inherit' });
        if (item.item.some((x) => !Array.isArray(x.item))) p.folders.push({ id: uid(), name: name.join(' / '), auth: auth.type === 'inherit' ? folderAuth : auth, requests: [] });
        walk(item.item, name, auth.type === 'inherit' ? folderAuth : auth);
      } else {
        const r = requestFromPm(item);
        const f = folderPath.length ? p.folders.find((x) => x.name === folderPath.join(' / ')) : null;
        (f || p).requests.push(r);
      }
    }
  };
  walk(data.item, [], { type: 'inherit' });
  const vars = rowsFromPm(data.variable);
  if (vars.length) { const env = { id: uid(), name: 'Collection variables', vars }; p.envs.push(env); p.activeEnv = env.id; }
  return p;
}
