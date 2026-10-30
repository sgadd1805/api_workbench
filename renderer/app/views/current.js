// The sidebar's Current view: feature groups of the requests being worked on, from any project.
import { $, esc } from '../../shared/html.js';
import { DB, S, findReq, methodLabel } from '../store.js';
import { icon } from '../../shared/icons.js';

function requestRow(f, id) {
  const loc = findReq(id); if (!loc) return '';
  const { p, r } = loc;
  return `<div class="sidebar-item request-item nested current-item${S.req?.id === id ? ' active' : ''}" data-action="open-req" data-id="${esc(id)}" data-kind="request" data-feature="${esc(f.id)}" draggable="true" title="${esc(`${p.name}${loc.f ? ' / ' + loc.f.name : ''}\n${r.method} ${r.url}`)}">
      <span class="method-tag m-${esc(methodLabel(r))}">${esc(methodLabel(r))}</span><span class="item-name">${esc(r.name)}</span>
      <span class="hint current-project">${esc(p.name)}</span>
      <button class="current-remove" data-action="feature-remove-item" data-id="${esc(f.id)}" data-req="${esc(id)}" title="Remove from ${esc(f.name)}">${icon('close')}</button></div>`;
}

function featureHtml(f) {
  const open = !f.collapsed;
  const holdsActive = S.req && f.requestIds.includes(S.req.id);
  const note = f.notes.split('\n').find((l) => l.trim());
  return `<div class="feature${f.done ? ' done' : ''}" data-feature="${esc(f.id)}">
    <div class="sidebar-item project-item feature-head${holdsActive ? ' active' : ''}" data-action="feature-toggle" data-id="${esc(f.id)}" data-kind="feature">
      <span class="expand-icon">${open ? icon('chevron-down') : icon('chevron-right')}</span><span class="item-name">${esc(f.name)}</span>
      ${f.branch ? `<span class="feature-branch" title="Git branch">⎇ ${esc(f.branch)}</span>` : ''}<span class="hint">${f.requestIds.length}</span></div>
    ${open ? `${note ? `<div class="hint feature-note" title="${esc(f.notes)}">${esc(note)}</div>` : ''}
      <div class="sidebar-actions">
        <button class="btn-ghost small" data-action="feature-add-open" data-id="${esc(f.id)}" ${S.req && !f.requestIds.includes(S.req.id) ? '' : 'disabled'} title="Add the request open in the editor">+ Open request</button>
        <button class="btn-ghost small" data-action="feature-open-all" data-id="${esc(f.id)}" ${f.requestIds.length ? '' : 'disabled'} title="Open every request as a tab">Open all</button>
        <button class="btn-ghost small" data-action="open-runner" data-scope="feature|${esc(f.id)}" ${f.requestIds.length ? '' : 'disabled'} title="Run these requests in order">${icon('play')}</button>
        <button class="btn-ghost small" data-action="feature-menu" data-id="${esc(f.id)}" title="Rename, notes, branch, done, delete">${icon('more')}</button></div>
      ${f.requestIds.map((id) => requestRow(f, id)).join('') || '<div class="hint feature-empty">No requests yet — open one and click "+ Open request", or use the request\'s ⋯ menu.</div>'}` : ''}
  </div>`;
}

export function renderCurrentList() {
  const active = DB.features.filter((f) => !f.done), done = DB.features.filter((f) => f.done);
  $('current-list').innerHTML = (active.map(featureHtml).join('') || '<div class="pad-10 hint">No features yet. Name what you\'re working on above, then add its requests.</div>')
    + (done.length ? `<details class="feature-done-group"${S.currentShowDone ? ' open' : ''}><summary class="hint" data-action="feature-done-toggle">Done (${done.length})</summary>${done.map(featureHtml).join('')}</details>` : '');
}
