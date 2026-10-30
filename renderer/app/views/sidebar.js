import { $, esc } from '../../shared/html.js';
import { DB, S, methodLabel } from '../store.js';
import { renderHistoryList } from './history.js';
import { renderCurrentList } from './current.js';
import { icon } from '../../shared/icons.js';

// The sidebar shows the project tree, the Current feature groups, or the History panel (S.sidebarMode).
const PANES = { projects: 'projects-pane', current: 'current-pane', history: 'history-pane' };

export function renderSidebar() {
  const mode = PANES[S.sidebarMode] ? S.sidebarMode : 'projects';
  for (const [m, id] of Object.entries(PANES)) $(id).style.display = m === mode ? '' : 'none';
  for (const b of document.querySelectorAll('.sidebar-mode')) b.classList.toggle('active', b.dataset.mode === mode);
  if (mode === 'history') return renderHistoryList();
  if (mode === 'current') return renderCurrentList();
  const rows = [];
  // data-kind: what a right-click, double-click (rename) or drop on the row acts on (actions/sidebar.js).
  const reqRow = (r, nested) => `<div class="sidebar-item request-item${nested ? ' nested' : ''}${S.req?.id === r.id ? ' active' : ''}" data-action="open-req" data-id="${esc(r.id)}" data-kind="request" draggable="true">
      <span class="method-tag m-${esc(methodLabel(r))}">${esc(methodLabel(r))}</span><span class="item-name">${esc(r.name)}</span></div>`;
  for (const p of DB.projects) {
    const open = S.projectOpen[p.id];
    rows.push(`<div class="sidebar-item project-item${S.projectId === p.id ? ' active' : ''}" data-action="toggle-project" data-id="${esc(p.id)}" data-kind="project">
      <span class="expand-icon">${open ? icon('chevron-down') : icon('chevron-right')}</span><span class="item-name">${esc(p.name)}</span></div>`);
    if (!open) continue;
    rows.push(`<div class="sidebar-actions">
      <button class="btn-ghost small" data-action="new-folder" data-id="${esc(p.id)}">+ Folder</button>
      <button class="btn-ghost small" data-action="new-request" data-id="${esc(p.id)}">+ Request</button>
      <button class="btn-ghost small" data-action="project-menu" data-id="${esc(p.id)}" title="Settings, rename, delete (or right-click the project)">${icon('more')}</button></div>`);
    for (const f of p.folders) {
      const fo = S.folderOpen[f.id];
      rows.push(`<div class="sidebar-item folder-item" data-action="toggle-folder" data-id="${esc(f.id)}" data-pid="${esc(p.id)}" data-kind="folder">
        <span class="expand-icon">${fo ? icon('chevron-down') : icon('chevron-right')}</span><span class="item-name">${icon('folder')} ${esc(f.name)}</span></div>`);
      if (fo) {
        rows.push(`<div class="sidebar-actions"><button class="btn-ghost small" data-action="new-request-in" data-id="${esc(f.id)}" data-pid="${esc(p.id)}">+ Request</button>
          <button class="btn-ghost small" data-action="open-runner" data-scope="folder|${esc(f.id)}" title="Run this folder">${icon('play')} Run</button>
          <button class="btn-ghost small" data-action="folder-menu" data-id="${esc(f.id)}" data-pid="${esc(p.id)}" title="Rename, run, delete (or right-click the folder)">${icon('more')}</button></div>`);
        for (const r of f.requests) rows.push(reqRow(r, true));
      }
    }
    for (const r of p.requests) rows.push(reqRow(r, false));
  }
  $('sidebar-list').innerHTML = rows.join('') || '<div class="pad-10 hint">No projects yet</div>';
}
