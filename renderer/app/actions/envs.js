// Environments page and the top bar's environment picker.
import { S, saveDB, currentProject, addEnv, deleteEnv, uid } from '../store.js';
import { renderAll, renderPage } from '../views/index.js';
import { selectedEnv } from '../views/envs.js';
import { openModal } from '../modal.js';
import { setPage } from './core.js';
import { undoable } from '../undo.js';

export const envActions = {
  'open-envs'() { S.envId = currentProject()?.activeEnv ?? null; setPage('envs'); },
  'close-page'() { setPage('request'); },
  'env-open'(d) { S.envId = d.id; renderPage(); },
  'env-add'() {
    const p = currentProject(); if (!p) return;
    openModal({ title: 'New environment', ok: 'Create', fields: [{ key: 'name', label: 'Name (e.g. dev, staging)' }],
      onOk: (v) => { if (!v.name.trim()) return; S.envId = addEnv(p, v.name.trim()).id; saveDB(); renderAll(); } });
  },
  'env-duplicate'(d) {
    const p = currentProject(), env = p?.envs.find((e) => e.id === d.id); if (!env) return;
    const copy = { ...structuredClone(env), id: uid(), name: env.name + ' copy' };
    p.envs.push(copy); S.envId = copy.id; saveDB(); renderPage();
  },
  'env-activate'(d) { const p = currentProject(); if (p) { p.activeEnv = d.id; saveDB(); renderAll(); } },
  'env-delete'(d) {
    const p = currentProject(), env = p?.envs.find((e) => e.id === d.id); if (!env) return;
    undoable(`Deleted environment "${env.name}"`, () => { deleteEnv(p, env.id); S.envId = null; });
  },
};

const NET_FILE_FILTERS = {
  caFile: [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer'] }], certFile: [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer'] }],
  keyFile: [{ name: 'Keys', extensions: ['pem', 'key'] }], pfxFile: [{ name: 'PKCS#12', extensions: ['pfx', 'p12'] }],
};

// Network settings on the envs page ('input' / 'change' on #net-…).
export function onNetworkInput(el) {
  const env = selectedEnv(currentProject());
  const field = el.id?.startsWith('net-') && el.id.slice(4);
  if (!env || !field || !(field in env.network)) return false;
  env.network[field] = el.type === 'checkbox' ? el.checked : el.value.trim();
  saveDB();
  if (el.type === 'checkbox') renderPage();
  return true;
}

export const networkActions = {
  async 'net-browse'(d) {
    const env = selectedEnv(currentProject()); if (!env) return;
    const path = await window.electronAPI.pickFile({ title: 'Choose file', filters: [...(NET_FILE_FILTERS[d.field] || []), { name: 'All files', extensions: ['*'] }] });
    if (path) { env.network[d.field] = path; saveDB(); renderPage(); }
  },
};

export function selectActiveEnv(id) {
  const p = currentProject(); if (!p) return;
  p.activeEnv = id || null; saveDB(); renderAll();
}

export function renameSelectedEnv(name) {
  const env = selectedEnv(currentProject()); if (!env) return;
  env.name = name; saveDB();
}
