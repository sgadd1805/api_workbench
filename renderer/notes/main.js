// The popped-out Notes window (notes.html). It holds a copy of the notes for drawing; every change is
// sent to the main window, which owns them, saves them and sends the result back (actions/notes.js,
// relayed by main/windows.js). Markup is shared with the side panel (shared/notesview.js).
import { noteTitle, parseTags, filterNotes, allTags, notesListHtml, tagBarHtml, noteEditorHtml, notesShellHtml } from '../shared/notesview.js';
import { esc } from '../shared/html.js';

const api = window.electronAPI;
const send = (msg) => api.notesToMain(msg);
const $ = (id) => document.getElementById(id);

let notes = [], projects = [], currentProjectId = null;
const ui = { id: null, preview: false, scope: 'project', filter: '', tag: '' };
let focusTitleWhenReady = false, firstState = true;

const project = (id) => projects.find((p) => p.id === id) || null;
const projectName = (id) => project(id)?.name;
const openNote = () => notes.find((n) => n.id === ui.id) || null;
const scoped = () => filterNotes(notes, { scope: ui.scope, projectId: currentProjectId });

function renderList() {
  const tags = allTags(scoped());
  if (ui.tag && !tags.some((t) => t.tag === ui.tag)) ui.tag = '';
  $('notes-list').innerHTML = notesListHtml(filterNotes(notes, { ...ui, projectId: currentProjectId }), { activeId: ui.id, showProject: ui.scope === 'all', projectName, total: notes.length });
  $('notes-tagbar').innerHTML = tagBarHtml(tags, ui.tag);
}

function render() {
  const cp = project(currentProjectId);
  $('notes-window-project').textContent = cp ? `· ${cp.name}` : '';
  $('notes-root').innerHTML = notesShellHtml({
    scope: ui.scope, currentProject: cp, filter: ui.filter, tagBar: '',
    editor: noteEditorHtml(openNote(), { preview: ui.preview, projectName, currentProject: cp, knownTags: allTags(notes).map((t) => t.tag), insert: true }),
  });
  renderList();
}

// A change to the open note: applied here at once (so typing is instant), then sent to the main window.
function edit(patch) {
  const n = openNote(); if (!n) return;
  Object.assign(n, patch, { updatedAt: Date.now() });
  notes = [n, ...notes.filter((x) => x !== n)];
  send({ type: 'update', id: n.id, patch });
  renderList();
}

// Keeps what's being typed when the main window's copy arrives a moment behind it.
function onState(m) {
  const typing = document.activeElement?.closest?.('.notes-editor');
  const mine = openNote();
  notes = m.notes.map((n) => (typing && mine && n.id === mine.id ? { ...n, title: mine.title, body: mine.body, tags: mine.tags } : { ...n }));
  projects = m.projects; currentProjectId = m.currentProjectId;
  // With no project selected (e.g. just after start) "this project" would hide project notes: show all.
  if (firstState) { firstState = false; if (!currentProjectId) ui.scope = 'all'; }
  if (m.theme) document.documentElement.dataset.theme = m.theme;
  if (ui.id && !openNote()) ui.id = null;
  if (typing && openNote()) renderList(); else render();
  if (focusTitleWhenReady && openNote()) { focusTitleWhenReady = false; $('note-title')?.focus(); }
}

// ── Insert menu (the open request / response, from the main window) ─────────────────────────────
let menuAnchor = null;
function showInsertMenu(items) {
  const menu = $('notes-menu');
  menu.innerHTML = items.map((it, i) => `<button class="menu-item" role="menuitem" data-insert="${i}" ${it.text == null ? 'disabled' : ''}><span>${esc(it.label)}</span></button>`).join('');
  menu.insertItems = items;
  const r = menuAnchor.getBoundingClientRect();
  Object.assign(menu.style, { position: 'fixed', left: Math.min(r.left, innerWidth - 240) + 'px', top: r.bottom + 2 + 'px' });
  menu.hidden = false;
  menu.querySelector('.menu-item:not([disabled])')?.focus();
}
const hideMenu = () => { $('notes-menu').hidden = true; };

function insert(text) {
  const n = openNote(); if (!n) return;
  const ta = $('note-body');
  if (!ta) return edit({ body: n.body + (n.body.endsWith('\n') || !n.body ? '' : '\n') + text }), render();
  const at = ta.selectionStart ?? ta.value.length;
  ta.setRangeText(text, at, ta.selectionEnd ?? at, 'end');
  edit({ body: ta.value }); ta.focus();
}

// ── events ────────────────────────────────────────────────────────────────────────────────────────
const ACTIONS = {
  'note-new'() { send({ type: 'new', projectId: ui.scope === 'project' ? currentProjectId : null }); },
  'note-open'(d) { ui.id = d.id; render(); },
  'note-preview'() { ui.preview = !ui.preview; render(); },
  'note-tag-filter'(d) { ui.tag = ui.tag === d.tag ? '' : d.tag; renderList(); },
  'note-link-project'() { const n = openNote(); if (n) { edit({ projectId: n.projectId ? null : currentProjectId }); render(); } },
  'note-delete'() {
    const n = openNote(); if (!n) return;
    if (!confirm(`Delete "${noteTitle(n)}"?`)) return;
    send({ type: 'delete', id: n.id }); ui.id = null;
  },
  'note-insert'(_d, el) { menuAnchor = el; send({ type: 'insert-options' }); },
  'notes-dock'() { api.notesDock(); },
};

document.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-insert]');
  if (pick) { const it = $('notes-menu').insertItems[+pick.dataset.insert]; hideMenu(); if (it?.text != null) insert(it.text); return; }
  if (!e.target.closest('#notes-menu')) hideMenu();
  const el = e.target.closest('[data-action]');
  if (el && !el.disabled) ACTIONS[el.dataset.action]?.(el.dataset, el);
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'note-title') edit({ title: el.value });
  else if (el.id === 'note-body') edit({ body: el.value });
  else if (el.id === 'note-tags') edit({ tags: parseTags(el.value) });
  else if (el.id === 'notes-filter') { ui.filter = el.value; renderList(); }
});
document.addEventListener('change', (e) => { if (e.target.id === 'notes-scope') { ui.scope = e.target.value; render(); } });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideMenu();
  // Enter / Space on list rows (they're divs).
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.note-item')) { e.preventDefault(); e.target.click(); }
});
// Make list rows focusable for the keyboard.
new MutationObserver(() => { for (const r of document.querySelectorAll('.note-item:not([tabindex])')) { r.tabIndex = 0; r.setAttribute('role', 'button'); } })
  .observe(document.body, { childList: true, subtree: true });

api.onNotesMessage((m) => {
  if (m.type === 'state') onState(m);
  if (m.type === 'created') { ui.id = m.id; ui.preview = false; focusTitleWhenReady = true; }
  if (m.type === 'insert-options' && menuAnchor) showInsertMenu(m.items);
});
send({ type: 'hello' });
