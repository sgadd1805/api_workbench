// Side panel → Notes, and the popped-out Notes window (renderer/notes/main.js). The notes always live in
// this window's DB: the Notes window asks for them and sends its edits here, via main/windows.js.
import { $ } from '../../shared/html.js';
import { prettyJson } from '../../shared/json.js';
import { S, saveDB, note, addNote, updateNote, deleteNote, currentProject, findReq, activeTab, DB, onAfterSave } from '../store.js';
import { buildRequest } from '../http.js';
import { renderSidePanel } from '../views/index.js';
import { renderNotesList, noteTitle } from '../views/notes.js';
import { parseTags } from '../../shared/notesview.js';
import { openMenu } from '../views/menu.js';
import { openModal } from '../modal.js';

const rerender = () => renderSidePanel();

// Inserts text at the cursor of the note editor (or appends, in preview mode).
function insertIntoNote(text) {
  const n = note(S.notes.id); if (!n) return;
  const ta = $('note-body');
  if (!ta) { updateNote(n.id, { body: n.body + (n.body.endsWith('\n') || !n.body ? '' : '\n') + text }); saveDB(); return rerender(); }
  const at = ta.selectionStart ?? ta.value.length;
  ta.setRangeText(text, at, ta.selectionEnd ?? at, 'end');
  updateNote(n.id, { body: ta.value }); saveDB(); renderNotesList(); ta.focus();
}

const block = (lang, text) => `\n\`\`\`${lang}\n${text}\n\`\`\`\n`;

// The Insert menu's choices for the open request / response: [{ label, text | null (unavailable) }].
async function insertChoices() {
  const loc = S.req && findReq(S.req.id), res = activeTab()?.response;
  let wire = null; try { wire = loc && buildRequest(loc); } catch {}
  const ok = res && !res.error;
  const { toCurl } = await import('../curl.js');
  return [
    { label: 'Request: method + URL', text: wire ? `\`${wire.method} ${wire.url}\`` : null },
    { label: 'Request as cURL', text: wire ? block('bash', toCurl(wire)) : null },
    { label: 'Response status + time', text: ok ? `${res.status} ${res.statusText} — ${res.time} ms` : null },
    { label: 'Response body', text: ok ? block('json', prettyJson(res.body).slice(0, 20000)) : null },
    { label: 'Date and time', text: new Date().toLocaleString() },
  ];
}

// ── popped-out Notes window ──────────────────────────────────────────────────────────────────────
const api = () => window.electronAPI;
export function pushNotes() {
  if (!S.notes.popped) return;
  const p = currentProject();
  api().notesToWindow({ type: 'state', notes: DB.notes, projects: DB.projects.map((x) => ({ id: x.id, name: x.name })), currentProjectId: p?.id ?? null, theme: DB.settings.theme });
}

function setPopped(on) {
  S.notes.popped = on;
  if (!!DB.settings.notesWindow !== on) { DB.settings.notesWindow = on; saveDB(); }
}

async function onWindowMessage(m) {
  if (m.type === 'hello') { setPopped(true); return pushNotes(); }
  if (m.type === 'new') { const n = addNote(m.projectId ?? null); saveDB(); api().notesToWindow({ type: 'created', id: n.id }); return pushNotes(); }
  if (m.type === 'update') { updateNote(m.id, m.patch); return saveDB(); } // pushed back after the save
  if (m.type === 'delete') { deleteNote(m.id); if (S.notes.id === m.id) S.notes.id = null; saveDB(); return pushNotes(); }
  if (m.type === 'insert-options') return api().notesToWindow({ type: 'insert-options', items: await insertChoices() });
  if (m.type === 'window-closed') { setPopped(false); return renderSidePanel(); }
  if (m.type === 'dock') { setPopped(false); return openSideRef?.('notes'); }
}

let openSideRef = null;
// Called once at startup. openSide comes from actions/layout.js (passed in to avoid an import cycle).
export function initNotesWindow(openSide) {
  openSideRef = openSide;
  api().onNotesMessage(onWindowMessage);
  onAfterSave(pushNotes);
  if (DB.settings.notesWindow) { S.notes.popped = true; api().openNotesWindow(); } // it was open when the app closed
}

export const notesPopOutHtml = () => `<div class="notes-popped"><p class="hint">Notes are open in their own window.</p>
  <div class="spec-row"><button class="btn-primary small" data-action="notes-show-window">Show the Notes window</button>
  <button class="btn-ghost small" data-action="notes-dock-here">Bring them back here</button></div></div>`;

export const noteActions = {
  'notes-pop-out'() { setPopped(true); api().openNotesWindow(); renderSidePanel(); },
  'notes-show-window'() { api().openNotesWindow(); },
  'notes-dock-here'() { api().notesDock(); },
  'note-new'() {
    const n = addNote(S.notes.scope === 'project' ? currentProject()?.id ?? null : null);
    S.notes.id = n.id; S.notes.preview = false; saveDB(); rerender();
    $('note-title')?.focus();
  },
  'note-open'(d) { S.notes.id = d.id; rerender(); },
  'note-tag-filter'(d) { S.notes.tag = S.notes.tag === d.tag ? '' : d.tag; renderNotesList(); },
  'note-preview'() { S.notes.preview = !S.notes.preview; rerender(); },
  'note-link-project'() {
    const n = note(S.notes.id); if (!n) return;
    updateNote(n.id, { projectId: n.projectId ? null : currentProject()?.id ?? null }); saveDB(); rerender();
  },
  'note-delete'() {
    const n = note(S.notes.id); if (!n) return;
    openModal({ title: `Delete "${noteTitle(n)}"?`, ok: 'Delete', fields: [], onOk: () => { deleteNote(n.id); S.notes.id = DB.notes[0]?.id ?? null; saveDB(); rerender(); } });
  },
  'note-insert'(_d, el) {
    const loc = S.req && findReq(S.req.id), res = activeTab()?.response;
    let wire = null; try { wire = loc && buildRequest(loc); } catch {}
    openMenu([
      { label: 'Request: method + URL', disabled: !wire, run: () => insertIntoNote(`\`${wire.method} ${wire.url}\``) },
      { label: 'Request as cURL', disabled: !wire, run: () => import('../curl.js').then((m) => insertIntoNote(block('bash', m.toCurl(wire)))) },
      { label: 'Response status + time', disabled: !res || res.error, run: () => insertIntoNote(`${res.status} ${res.statusText} — ${res.time} ms`) },
      { label: 'Response body', disabled: !res || res.error, run: () => insertIntoNote(block('json', prettyJson(res.body).slice(0, 20000))) },
      { sep: true },
      { label: 'Date and time', run: () => insertIntoNote(new Date().toLocaleString()) },
    ], el);
  },
};

// Typing in the title / body / filter, and the scope picker.
export function onNoteInput(el) {
  if (el.id === 'note-title') { updateNote(S.notes.id, { title: el.value }); saveDB(); renderNotesList(); return true; }
  if (el.id === 'note-body') { updateNote(S.notes.id, { body: el.value }); saveDB(); renderNotesList(); return true; }
  if (el.id === 'notes-filter') { S.notes.filter = el.value; renderNotesList(); return true; }
  if (el.id === 'note-tags') { updateNote(S.notes.id, { tags: parseTags(el.value) }); saveDB(); renderNotesList(); return true; }
  return false;
}
export function onNoteChange(el) {
  if (el.id !== 'notes-scope') return false;
  S.notes.scope = el.value; rerender();
  return true;
}
