// Specs page: attach Swagger/OpenAPI documents to the current project and create requests from them;
// plus the request editor's Spec tab (operation link, example body).
import { notify } from '../../shared/notify.js';
import { S, saveDB, currentProject, findReq, uid, newReq, addFolder, addRequest, allRequests, activeEnv, addEnv } from '../store.js';
import { activeVars, resolve } from '../vars.js';
import { specAnalysis, cacheSpec, forgetSpec, ensureProjectSpecs, operationFor } from '../openapi/registry.js';
import { requestFieldsFor, variablesFor, bodyFor, operationLabel } from '../openapi/generate.js';
import { buildRequest } from '../http.js';
import { renderAll, renderPage, renderRequestPanel, renderSidePanel } from '../views/index.js';
import { openModal } from '../modal.js';
import { openReq, setPage } from './core.js';

const api = window.electronAPI;

// Reads a spec from a file path or URL and attaches it (or refreshes the one already attached from
// the same place). → the spec's metadata, or null on failure.
export async function attachSpec(p, source) {
  const res = await api.specsRead(source.location);
  if (!res.ok) { notify(`Could not read ${source.location}: ${res.error}`, 'error', 9000); return null; }
  const existing = p.specs.find((s) => s.source.location === source.location);
  const id = existing?.id || uid();
  const saved = await api.specStoreSave(id, res.doc);
  if (!saved.ok) { notify('Could not store the spec: ' + saved.error, 'error'); return null; }
  cacheSpec(id, res.doc);
  const meta = { id, title: res.title, version: res.version, specVersion: res.specVersion, operationCount: res.operationCount, source, importedAt: Date.now() };
  if (existing) Object.assign(existing, meta); else p.specs.push(meta);
  saveDB();
  return existing || meta;
}

async function attachAndOffer(p, source) {
  const meta = await attachSpec(p, source);
  if (!meta) return;
  renderAll();
  notify(`Attached ${meta.title} (${meta.operationCount} operations)`);
  createRequestsDialog(p, meta);
}

const GROUPING = [
  { value: 'tag', label: 'A folder per tag' },
  { value: 'spec', label: 'One folder named after the spec' },
  { value: 'root', label: 'Project root' },
];

function createRequestsDialog(p, meta) {
  const analysis = specAnalysis(meta.id); if (!analysis) return;
  const linked = new Set(allRequests(p).filter((r) => r.spec?.specId === meta.id).map((r) => r.spec.opKey));
  openModal({ title: `Create requests from ${meta.title}`, ok: 'Create', wide: true,
    hint: 'Each operation becomes a request using {{baseUrl}} and {{path param}} variables, which are added to the active environment if missing. Operations that already have a request are unticked.',
    fields: [
      { key: 'ops', label: `Operations (${analysis.operations.length})`, type: 'checklist',
        options: analysis.operations.map((op) => ({ value: op.key, label: operationLabel(op) + (linked.has(op.key) ? '  [exists]' : ''), checked: !linked.has(op.key) && !op.deprecated })) },
      { key: 'group', label: 'Put them in', type: 'select', options: GROUPING, value: 'tag' }],
    onOk: (v) => createRequests(p, meta, analysis, analysis.operations.filter((op) => v.ops.includes(op.key)), v.group) });
}

// Variables the requests need (baseUrl, path params) go into the active environment (created if
// there is none); only missing ones are added, never overwriting values the user has set. → added vars
function addMissingVars(p, meta, analysis, ops) {
  const env = activeEnv(p) || addEnv(p, meta.title);
  p.activeEnv = env.id;
  const added = variablesFor(analysis, ops).filter((v) => !env.vars.some((x) => x.k === v.k));
  env.vars.push(...added.map((v) => ({ ...v, on: true })));
  return { env, added };
}

function addOperationRequest(p, meta, analysis, op, group) {
  const name = group === 'root' ? null : group === 'spec' ? meta.title : op.tags[0] || 'Other';
  const f = name ? p.folders.find((x) => x.name === name) || addFolder(p, name) : null;
  if (f) S.folderOpen[f.id] = true;
  S.projectOpen[p.id] = true;
  return addRequest(p, f, newReq(requestFieldsFor(analysis, op, meta.id)));
}

// One operation → a new request in its tag's folder (used by API search). Caller saves.
export function requestForOperation(p, meta, op) {
  const analysis = specAnalysis(meta.id);
  addMissingVars(p, meta, analysis, [op]);
  return addOperationRequest(p, meta, analysis, op, 'tag');
}

function createRequests(p, meta, analysis, ops, group) {
  if (!ops.length) return;
  const created = ops.map((op) => addOperationRequest(p, meta, analysis, op, group));
  const { env, added } = addMissingVars(p, meta, analysis, ops);
  saveDB(); openReq(created[0].id);
  notify(`Created ${created.length} request${created.length === 1 ? '' : 's'}${added.length ? `; added ${added.map((v) => `{{${v.k}}}`).join(', ')} to "${env.name}"` : ''}`, 'info', 7000);
}

export const specActions = {
  async 'open-specs'() {
    const p = currentProject(); if (!p) return;
    setPage('specs');
    if (await ensureProjectSpecs(p)) renderPage();
  },
  async 'specs-find'() {
    const p = currentProject(); if (!p) return;
    const folder = await api.pickFolder(); if (!folder) return;
    if (!p.codeFolder) { p.codeFolder = folder; saveDB(); } // also used for git history and the terminal
    notify('Searching ' + folder + ' …', 'info', 60000);
    const res = await api.specsFind(folder);
    if (!res.ok) return notify(res.error, 'error');
    const usable = res.specs.filter((s) => !s.error);
    if (!res.specs.length) return notify('No swagger/openapi files found in that folder', 'error', 7000);
    notify(`Found ${usable.length} spec${usable.length === 1 ? '' : 's'}`);
    openModal({ title: 'Specs found in ' + folder, ok: 'Attach', wide: true,
      hint: 'Files whose JSON/YAML starts with an "openapi" or "swagger" field. node_modules, .git and build folders are skipped.',
      fields: [{ key: 'pick', label: 'Attach to ' + p.name, type: 'checklist', options: res.specs.map((s) => ({
        value: s.path, checked: !s.error && !p.specs.some((x) => x.source.location === s.path),
        label: s.error ? `${s.rel} — ✗ ${s.error}` : `${s.rel} — ${s.title}${s.version ? ' v' + s.version : ''} (${s.specVersion}, ${s.operationCount} ops)`,
      })) }],
      onOk: async (v) => {
        const picked = v.pick.filter((loc) => usable.some((s) => s.path === loc));
        if (picked.length === 1) return attachAndOffer(p, { type: 'file', location: picked[0] });
        let n = 0;
        for (const location of picked) if (await attachSpec(p, { type: 'file', location })) n++;
        renderAll();
        if (n) notify(`Attached ${n} specs. Use "Create requests…" on each to import operations.`, 'info', 7000);
      } });
  },
  async 'specs-add-file'() {
    const p = currentProject(); if (!p) return;
    const location = await api.specsPickFile();
    if (location) attachAndOffer(p, { type: 'file', location });
  },
  'specs-add-url'() {
    const p = currentProject(); if (!p) return;
    openModal({ title: 'Add spec from URL', ok: 'Fetch',
      hint: 'For apps that serve their spec at runtime (Spring: /v3/api-docs or /v2/api-docs). {{variables}} from the active environment are resolved.',
      fields: [{ key: 'url', label: 'URL', value: activeVars(p).baseUrl ? '{{baseUrl}}/v3/api-docs' : 'http://localhost:8080/v3/api-docs' }],
      onOk: (v) => {
        const location = resolve(v.url.trim(), activeVars(p));
        if (!/^https?:\/\//i.test(location)) return notify('Enter an http(s) URL', 'error');
        attachAndOffer(p, { type: 'url', location });
      } });
  },
  'spec-create-requests'(d) {
    const p = currentProject(), meta = p?.specs.find((s) => s.id === d.id);
    if (meta) createRequestsDialog(p, meta);
  },
  async 'spec-reload'(d) {
    const p = currentProject(), meta = p?.specs.find((s) => s.id === d.id); if (!meta) return;
    if (await attachSpec(p, meta.source)) { renderAll(); notify(`Reloaded ${meta.title}`); }
  },
  'spec-remove'(d) {
    const p = currentProject(), meta = p?.specs.find((s) => s.id === d.id); if (!meta) return;
    openModal({ title: `Remove ${meta.title}?`, ok: 'Remove', hint: 'Requests created from it are kept; they are just no longer checked against it.',
      fields: [{ key: 'confirm', label: 'Type REMOVE to confirm' }],
      onOk: (v) => {
        if (v.confirm.trim().toUpperCase() !== 'REMOVE') return;
        p.specs = p.specs.filter((s) => s.id !== meta.id);
        for (const r of allRequests(p)) if (r.spec?.specId === meta.id) r.spec = null;
        forgetSpec(meta.id); api.specStoreDelete(meta.id);
        saveDB(); renderAll();
      } });
  },

  // ---- request editor Spec tab
  'spec-recheck'() { renderSidePanel(); },
  'spec-example-body'() {
    const loc = findReq(S.req.id); if (!loc) return;
    const wire = buildRequest(loc);
    const match = operationFor(loc, wire.method, wire.url); if (!match?.op.requestBody) return;
    const { body, contentType } = bodyFor(match.op, match.analysis.doc);
    loc.r.body = body;
    if (contentType) {
      const h = loc.r.headers.find((x) => x.k.toLowerCase() === 'content-type');
      if (h) { h.v = contentType; h.on = true; } else loc.r.headers.push({ k: 'Content-Type', v: contentType, on: true });
    }
    saveDB(); renderRequestPanel(); notify('Example body inserted (see the Body tab)');
  },
};

// 'change' on the Spec tab's operation picker: 'specId|GET /path' or '' for automatic matching.
export function linkOperation(value) {
  const r = S.req; if (!r) return;
  const sep = value.indexOf('|');
  r.spec = value ? { specId: value.slice(0, sep), opKey: value.slice(sep + 1) } : null;
  saveDB(); renderRequestPanel(); renderSidePanel();
}
