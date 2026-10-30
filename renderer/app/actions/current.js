// Sidebar → Current: feature groups of in-progress requests.
import { $ } from '../../shared/html.js';
import { notify } from '../../shared/notify.js';
import { S, saveDB, feature, addFeature, deleteFeature, addToFeature, removeFromFeature, activateTab } from '../store.js';
import { renderAll, renderSidebar } from '../views/index.js';
import { openModal } from '../modal.js';
import { openReq } from './core.js';
import { undoable } from '../undo.js';

export function createFeature(name, { withOpenRequest = false } = {}) {
  const f = addFeature(name);
  if (withOpenRequest && S.req) addToFeature(f.id, S.req.id);
  saveDB(); renderSidebar();
  return f;
}

export const currentActions = {
  'new-feature'() {
    const input = $('new-feature-input'); const name = input.value.trim(); if (!name) return;
    input.value = '';
    createFeature(name);
  },
  'feature-toggle'(d) { const f = feature(d.id); if (f) { f.collapsed = !f.collapsed; saveDB(); renderSidebar(); } },
  'feature-done-toggle'() { S.currentShowDone = !S.currentShowDone; renderSidebar(); },
  'feature-add-open'(d) {
    if (!S.req) return;
    if (addToFeature(d.id, S.req.id)) { saveDB(); renderSidebar(); }
  },
  'feature-remove-item'(d) { removeFromFeature(d.id, d.req); saveDB(); renderSidebar(); },
  // Opens every request of the feature as a tab and shows the first.
  'feature-open-all'(d) {
    const f = feature(d.id); if (!f?.requestIds.length) return;
    for (const id of f.requestIds) activateTab(id);
    openReq(f.requestIds[0]);
  },
  'feature-menu'(d) {
    const f = feature(d.id); if (!f) return;
    openModal({ title: 'Feature: ' + f.name, ok: 'Save', fields: [
      { key: 'name', label: 'Name', value: f.name },
      { key: 'branch', label: 'Git branch (optional label)', value: f.branch },
      { key: 'notes', label: 'Notes', type: 'textarea', value: f.notes },
      { key: 'status', label: 'Status', type: 'select', value: f.done ? 'done' : 'active', options: [{ value: 'active', label: 'In progress' }, { value: 'done', label: 'Done' }] }],
    danger: { label: 'Delete group', run: () => undoable(`Deleted group "${f.name}" (its requests are kept)`, () => deleteFeature(f.id)) },
    onOk: (v) => {
      Object.assign(f, { name: v.name.trim() || f.name, branch: v.branch.trim(), notes: v.notes, done: v.status === 'done' });
      saveDB(); renderAll();
    } });
  },
};


