// Side panel → Notes: a list of Markdown notes (filterable by text and tag) and an editor for the open
// one. The markup is shared with the popped-out Notes window (shared/notesview.js).
import { $ } from '../../shared/html.js';
import { DB, S, note, currentProject, project } from '../store.js';
import { noteTitle, filterNotes, allTags, notesListHtml, tagBarHtml, noteEditorHtml, notesShellHtml } from '../../shared/notesview.js';

export { noteTitle };

const projectName = (id) => project(id)?.name;
const scoped = () => filterNotes(DB.notes, { scope: S.notes.scope, projectId: currentProject()?.id ?? null });

// Just the list and tag bar, so typing in the editor or filter doesn't lose focus.
export function renderNotesList() {
  const el = $('notes-list'); if (!el) return;
  const tags = allTags(scoped());
  if (S.notes.tag && !tags.some((t) => t.tag === S.notes.tag)) S.notes.tag = '';
  const items = filterNotes(DB.notes, { scope: S.notes.scope, projectId: currentProject()?.id ?? null, filter: S.notes.filter, tag: S.notes.tag });
  el.innerHTML = notesListHtml(items, { activeId: S.notes.id, showProject: S.notes.scope === 'all', projectName, total: DB.notes.length });
  const bar = $('notes-tagbar'); if (bar) bar.innerHTML = tagBarHtml(tags, S.notes.tag);
}

export function notesHtml() {
  const p = currentProject();
  return notesShellHtml({
    scope: S.notes.scope, currentProject: p, filter: S.notes.filter, tagBar: '',
    editor: noteEditorHtml(note(S.notes.id), { preview: S.notes.preview, projectName, currentProject: p, knownTags: allTags(DB.notes).map((t) => t.tag), insert: true }),
  });
}
