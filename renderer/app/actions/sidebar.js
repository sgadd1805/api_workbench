// Sidebar: projects, folders and requests. Each row has a menu (right-click, or its ⋯ button),
// renames in place on double-click, and requests drag between folders, projects and feature groups.
// Deletes happen at once with Undo on the toast (undo.js).
import { $ } from '../../shared/html.js';
import { notify } from '../../shared/notify.js';
import { DB, S, saveDB, project, folder, findReq, feature, addProject, addFolder, addRequest, deleteProject, deleteFolder, deleteRequest,
  duplicateRequest, placeRequest, openFeatures, featuresWith, addFeature, addToFeature, deleteFeature, projectAuthFromForm, projectAuthToForm } from '../store.js';
import { renderAll, renderSidebar } from '../views/index.js';
import { openMenu } from '../views/menu.js';
import { openModal } from '../modal.js';
import { undoable } from '../undo.js';
import { DEFAULT_DIR, safeRepoSubdir } from '../repo.js';
import { refreshRepoWatches } from './repo.js';
import { checkConfig } from './config.js';
import { pushNotes } from './notes.js';
import { openReq } from './core.js';
import { runnerActions } from './runner.js';
import { loadActions } from './load.js';

function newFolder(p) {
  openModal({ title: 'New folder', ok: 'Create', fields: [{ key: 'name', label: 'Name' }],
    onOk: (v) => { if (v.name.trim()) { const f = addFolder(p, v.name.trim()); S.projectOpen[p.id] = S.folderOpen[f.id] = true; saveDB(); renderSidebar(); } } });
}

function projectSettings(p) {
  openModal({ title: 'Project: ' + p.name, ok: 'Save', fields: [
    { key: 'name', label: 'Name', value: p.name },
    { key: 'authType', label: 'Auth (inherited by requests)', type: 'select', options: [{ value: 'none', label: 'none' }, { value: 'bearer', label: 'bearer' }, { value: 'basic', label: 'basic' }, { value: 'token', label: 'token source' }], value: p.auth?.type || 'none' },
    { key: 'source', label: 'Token source (when auth is "token source")', type: 'select', options: [{ value: '', label: DB.tokenSources.length ? '(choose)' : '(none yet: Project → Token sources…)' }, ...DB.tokenSources.map((t) => ({ value: t.id, label: t.name }))], value: p.auth?.sourceId || '' },
    { key: 'token', label: 'Bearer token / basic "user:pass" ({{variables}} allowed)', value: projectAuthToForm(p.auth) },
    { key: 'cookies', label: 'Cookie jar (sent with every request unless one sets Cookie)', value: p.cookies || '' },
    { key: 'codeFolder', label: 'Code folder (for git history, the terminal and tasks)', value: p.codeFolder || '' },
    { key: 'correlation', label: 'Tag requests with X-Request-Id and traceparent (for the Logs tab)', type: 'select', value: p.correlation ? 'on' : 'off', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] },
    { key: 'traceUrl', label: 'Trace viewer link (optional), e.g. http://localhost:16686/trace/{traceId}', value: p.traceUrl || '' },
    { key: 'scriptPre', label: 'Pre-request script for every request (runs before the request\'s own)', type: 'textarea', value: p.scripts?.pre || '' },
    { key: 'scriptPost', label: 'Post-response script for every request', type: 'textarea', value: p.scripts?.post || '' },
    { key: 'repoDir', label: `Requests as files: folder inside the code folder (${DEFAULT_DIR} if empty)`, value: p.repo?.dir || '' },
    { key: 'repoAuto', label: 'Keep request files in sync (write on every change; offer to reload when they change, e.g. after git pull)', type: 'select', value: p.repo?.auto ? 'on' : 'off', options: [{ value: 'off', label: 'Off (use Project → Save / Load requests)' }, { value: 'on', label: 'On' }] }],
  danger: { label: 'Delete project', run: () => removeProject(p) },
  onOk: (v) => {
    Object.assign(p, { name: v.name || p.name, auth: projectAuthFromForm(v.authType, v.token, v.source), cookies: v.cookies.trim(), codeFolder: v.codeFolder.trim(),
      correlation: v.correlation === 'on', traceUrl: v.traceUrl.trim(), scripts: { pre: v.scriptPre, post: v.scriptPost },
      repo: { ...(p.repo || {}), dir: v.repoDir.trim(), auto: v.repoAuto === 'on' } });
    if (p.repo.auto && !p.codeFolder) notify('Set a code folder for the request files', 'error');
    if (p.repo.dir && !safeRepoSubdir(p.repo.dir)) notify(`"${p.repo.dir}" isn't a folder inside the code folder, so request files use ${DEFAULT_DIR}/`, 'error', 8000);
    saveDB(); renderAll(); refreshRepoWatches(); checkConfig(p);
  } });
}

const removeProject = (p) => undoable(`Deleted project "${p.name}"`, () => deleteProject(p.id));
const removeFolder = (p, f) => undoable(`Deleted folder "${f.name}" and its ${f.requests.length} request(s)`, () => deleteFolder(p, f.id));
const removeRequest = (r) => undoable(`Deleted "${r.name}"`, () => deleteRequest(r.id));

// Menu items for a sidebar row (also the ⋯ buttons and the request editor's ⋯).
export function rowMenu(kind, id, pid) {
  if (kind === 'project') {
    const p = project(id); if (!p) return [];
    return [
      { label: 'New request', run: () => sidebarActions['new-request']({ id }) },
      { label: 'New folder…', run: () => newFolder(p) },
      { label: 'Run collection…', run: () => runnerActions['open-runner']({ scope: `project|${id}` }) },
      { sep: true },
      { label: 'Rename', hint: 'double-click', run: () => startRename('project', id) },
      { label: 'Settings…', hint: 'auth, cookies, scripts', run: () => projectSettings(p) },
      { sep: true },
      { label: 'Delete project', danger: true, run: () => removeProject(p) }];
  }
  if (kind === 'folder') {
    const p = project(pid), f = folder(p, id); if (!f) return [];
    return [
      { label: 'New request', run: () => sidebarActions['new-request-in']({ id, pid }) },
      { label: 'Run folder…', run: () => runnerActions['open-runner']({ scope: `folder|${id}` }) },
      { sep: true },
      { label: 'Rename', hint: 'double-click', run: () => startRename('folder', id, pid) },
      { label: 'Delete folder', danger: true, run: () => removeFolder(p, f) }];
  }
  const loc = findReq(id); if (!loc) return [];
  const here = loc.f?.id || '';
  const inFeatures = new Set(featuresWith(id).map((f) => f.id));
  const targets = DB.projects.flatMap((p) => [{ p, f: null }, ...p.folders.map((f) => ({ p, f }))]);
  return [
    { label: 'Open', run: () => openReq(id) },
    { label: 'Rename', hint: 'double-click', run: () => startRename('request', id) },
    { label: 'Duplicate', run: () => { const copy = duplicateRequest(id); saveDB(); if (copy) openReq(copy.id); } },
    { label: 'Load test…', run: () => { openReq(id); loadActions['open-load'](); } },
    { head: 'Move to (or drag it)' },
    ...targets.map(({ p, f }) => ({
      label: `${DB.projects.length > 1 ? p.name + ' / ' : ''}${f ? f.name : '(project root)'}`,
      disabled: p === loc.p && (f?.id || '') === here,
      run: () => { placeRequest(id, { projectId: p.id, folderId: f?.id }); if (f) S.folderOpen[f.id] = true; S.projectOpen[p.id] = true; saveDB(); renderAll(); },
    })),
    { head: 'Add to feature (sidebar → Current)' },
    ...openFeatures().map((f) => ({ label: f.name, disabled: inFeatures.has(f.id), hint: inFeatures.has(f.id) ? 'added' : '', run: () => { addToFeature(f.id, id); saveDB(); renderSidebar(); notify(`Added to "${f.name}"`); } })),
    { label: '+ New feature named after this request', run: () => { const f = addFeature(loc.r.name); addToFeature(f.id, id); saveDB(); renderSidebar(); notify(`Added to new feature "${f.name}" (sidebar → Current)`); } },
    { sep: true },
    { label: 'Delete request', danger: true, run: () => removeRequest(loc.r) }];
}

// ── rename in place ───────────────────────────────────────────────────────────────────────────────
function rowEl(kind, id) {
  return document.querySelector(`#sidebar .sidebar-item[data-kind="${kind}"][data-id="${CSS.escape(id)}"]`);
}

function nameOf(kind, id, pid) {
  if (kind === 'project') return project(id);
  if (kind === 'folder') return folder(project(pid), id);
  if (kind === 'feature') return feature(id);
  return findReq(id)?.r;
}

export function startRename(kind, id, pid) {
  const obj = nameOf(kind, id, pid); if (!obj) return;
  const label = rowEl(kind, id)?.querySelector('.item-name');
  if (!label) {
    // Not visible in the sidebar (e.g. a collapsed folder): ask in a dialog instead.
    return openModal({ title: 'Rename', ok: 'Rename', fields: [{ key: 'name', label: 'Name', value: obj.name }],
      onOk: (v) => { if (v.name.trim()) { obj.name = v.name.trim(); saveDB(); renderAll(); } } });
  }
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'rename-input'; input.value = obj.name; input.setAttribute('aria-label', 'Name');
  // Clicks in the box mustn't reach the row's own action (open / expand).
  for (const ev of ['click', 'mousedown', 'dblclick']) input.addEventListener(ev, (e) => e.stopPropagation());
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    if (save && input.value.trim() && input.value.trim() !== obj.name) { obj.name = input.value.trim(); saveDB(); }
    renderAll();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  label.replaceWith(input);
  input.focus(); input.select();
}

// ── right-click, double-click, drag and drop ──────────────────────────────────────────────────────
const rowAt = (e) => document.elementFromPoint(e.clientX, e.clientY)?.closest('#sidebar .sidebar-item[data-kind]');

function featureMenu(id) {
  const f = feature(id); if (!f) return [];
  return [
    { label: 'Rename', hint: 'double-click', run: () => startRename('feature', id) },
    { label: 'Edit notes, branch, status…', run: () => ACTIONS_REF?.['feature-menu']({ id }) },
    { label: f.done ? 'Mark in progress' : 'Mark done', run: () => { f.done = !f.done; saveDB(); renderSidebar(); } },
    { sep: true },
    { label: 'Delete group (requests are kept)', danger: true, run: () => undoable(`Deleted group "${f.name}"`, () => deleteFeature(id)) }];
}

let ACTIONS_REF = null; // the full action table, for menu items that reuse other modules' actions
let dragId = null;

export function wireSidebar(actions) {
  ACTIONS_REF = actions;
  const side = $('sidebar');
  side.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.sidebar-item[data-kind]'); if (!row) return;
    e.preventDefault();
    const { kind, id, pid } = row.dataset;
    const items = kind === 'feature' ? featureMenu(id) : rowMenu(kind, id, pid);
    if (items.length) openMenu(items, { x: e.clientX, y: e.clientY });
  });
  side.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, input')) return;
    // The first click re-rendered the list, so find the row under the pointer now.
    const row = rowAt(e); if (!row) return;
    // (The two clicks toggled a project / folder / group open and shut again, so it's as it was.)
    e.preventDefault();
    startRename(row.dataset.kind, row.dataset.id, row.dataset.pid);
  });
  side.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('.sidebar-item[data-kind="request"]'); if (!row) return;
    dragId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', findReq(dragId)?.r.name || '');
    row.classList.add('dragging');
  });
  const target = (e) => (dragId ? e.target.closest?.('.sidebar-item[data-kind], .feature[data-feature]') : null);
  const clear = () => { for (const el of side.querySelectorAll('.drop-before, .drop-into, .dragging')) el.classList.remove('drop-before', 'drop-into', 'dragging'); };
  side.addEventListener('dragover', (e) => {
    const t = target(e); if (!t) return;
    e.preventDefault();
    for (const el of side.querySelectorAll('.drop-before, .drop-into')) if (el !== t) el.classList.remove('drop-before', 'drop-into');
    const inFeature = t.closest('.feature');
    e.dataTransfer.dropEffect = inFeature ? 'copy' : 'move';
    t.classList.add(!inFeature && t.dataset.kind === 'request' ? 'drop-before' : 'drop-into');
  });
  side.addEventListener('dragend', () => { dragId = null; clear(); });
  side.addEventListener('drop', (e) => {
    const t = target(e); if (!t) return;
    e.preventDefault();
    const id = dragId; dragId = null; clear();
    const fid = t.closest('.feature')?.dataset.feature;
    if (fid) {
      const f = feature(fid);
      if (addToFeature(fid, id)) { f.collapsed = false; saveDB(); renderSidebar(); notify(`Added to "${f.name}"`); }
      return;
    }
    const { kind, id: tid, pid } = t.dataset;
    let moved = false;
    if (kind === 'project') moved = placeRequest(id, { projectId: tid });
    else if (kind === 'folder') { moved = placeRequest(id, { projectId: pid, folderId: tid }); S.folderOpen[tid] = true; }
    else if (kind === 'request' && tid !== id) {
      const loc = findReq(tid);
      moved = loc && placeRequest(id, { projectId: loc.p.id, folderId: loc.f?.id, beforeId: tid });
    }
    if (moved) { saveDB(); renderAll(); }
  });
}

export const sidebarActions = {
  'new-project'() {
    const inp = $('new-project-input'); const name = inp.value.trim(); if (!name) return;
    const p = addProject(name);
    S.projectOpen[p.id] = true; S.projectId = p.id; inp.value = '';
    saveDB(); renderAll();
  },
  'toggle-project'(d) { const changed = S.projectId !== d.id; S.projectOpen[d.id] = !S.projectOpen[d.id]; S.projectId = d.id; renderAll(); if (changed) { checkConfig(project(d.id)); pushNotes(); } },
  'toggle-folder'(d) { S.folderOpen[d.id] = !S.folderOpen[d.id]; renderSidebar(); },
  'new-folder'(d) { newFolder(project(d.id)); },
  'new-request'(d) { const r = addRequest(project(d.id), null); S.projectOpen[d.id] = true; saveDB(); openReq(r.id); },
  'new-request-in'(d) {
    const p = project(d.pid), f = folder(p, d.id);
    const r = addRequest(p, f); S.folderOpen[f.id] = true; saveDB(); openReq(r.id);
  },
  'project-menu'(d, el) { openMenu(rowMenu('project', d.id), el); },
  'project-settings'(d) { const p = project(d.id); if (p) projectSettings(p); },
  'folder-menu'(d, el) { openMenu(rowMenu('folder', d.id, d.pid), el); },
  'open-req'(d) { openReq(d.id); },
};
