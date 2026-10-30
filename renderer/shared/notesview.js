// Notes rendering shared by the main window's side panel (renderer/app/views/notes.js) and the
// popped-out Notes window (renderer/notes/main.js). Pure functions over plain data, so both windows
// draw the same list, tag bar and editor from their own copy of the notes.
// Note: { id, title, body (Markdown), tags: [string], projectId | null, createdAt, updatedAt }
import { esc } from './html.js';
import { markdown } from './markdown.js';
import { icon } from './icons.js';

const fmt = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const noteTitle = (n) => n.title.trim() || n.body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 60) || 'Untitled note';

// "bug, #api  Follow-up" → ['bug', 'api', 'follow-up']: lower case, no '#', spaces inside a tag become '-'.
export function parseTags(text) {
  const out = [];
  for (const raw of String(text || '').split(/[,\n]/)) {
    for (const part of raw.trim().split(/\s+#/)) {
      const t = part.replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_./-]/gu, '').slice(0, 40);
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

// Every tag in these notes, most used first. → [{ tag, count }]
export function allTags(notes) {
  const counts = new Map();
  for (const n of notes) for (const t of n.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// opts: { scope: 'project' | 'all', projectId, filter (text; "#tag" words must be tags), tag (selected tag or '') }
export function filterNotes(notes, { scope = 'project', projectId = null, filter = '', tag = '' } = {}) {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return notes.filter((n) => {
    if (scope !== 'all' && n.projectId && n.projectId !== projectId) return false;
    const tags = n.tags || [];
    if (tag && !tags.includes(tag)) return false;
    const text = `${n.title}\n${n.body}`.toLowerCase();
    return words.every((w) => (w.startsWith('#') && w.length > 1 ? tags.includes(w.slice(1)) : text.includes(w) || tags.some((t) => t.includes(w))));
  });
}

const chips = (tags) => (tags || []).map((t) => `<span class="note-tag">#${esc(t)}</span>`).join('');

// items: the filtered notes. ctx: { activeId, showProject, projectName(id), total }
export function notesListHtml(items, ctx) {
  if (!items.length) return `<div class="pad-8 hint">${ctx.total ? 'No matching notes' : 'No notes yet'}</div>`;
  return items.map((n) => `<div class="sidebar-item note-item${n.id === ctx.activeId ? ' active' : ''}" data-action="note-open" data-id="${esc(n.id)}">
      <span class="item-name">${esc(noteTitle(n))}</span>
      ${ctx.showProject && n.projectId ? `<span class="hint">${esc(ctx.projectName(n.projectId) || '')}</span>` : ''}
      <span class="hint">${esc(fmt(n.updatedAt))}</span>${n.tags?.length ? `<span class="note-tags">${chips(n.tags)}</span>` : ''}</div>`).join('');
}

// The tag filter bar above the list (only when some notes have tags).
export function tagBarHtml(tags, selected) {
  if (!tags.length) return '';
  return `<div class="note-tagbar" role="group" aria-label="Filter by tag">
    <button class="note-tag-btn${selected ? '' : ' active'}" data-action="note-tag-filter" data-tag="">All</button>
    ${tags.map(({ tag, count }) => `<button class="note-tag-btn${tag === selected ? ' active' : ''}" data-action="note-tag-filter" data-tag="${esc(tag)}" aria-pressed="${tag === selected}">#${esc(tag)} <span class="hint">${count}</span></button>`).join('')}</div>`;
}

// ctx: { preview, projectName(id), currentProject: { id, name } | null, knownTags: [tag], insert: bool }
export function noteEditorHtml(n, ctx) {
  if (!n) return '<p class="hint">Pick a note, or create one.</p>';
  const p = ctx.currentProject;
  return `<div class="note-toolbar">
      <input type="text" id="note-title" placeholder="${esc(noteTitle(n))}" value="${esc(n.title)}" spellcheck="true" aria-label="Title"/>
      <button class="btn-ghost small${ctx.preview ? ' compare-active' : ''}" data-action="note-preview" title="Toggle Markdown preview">${ctx.preview ? 'Edit' : 'Preview'}</button>
      ${ctx.insert ? '<button class="btn-ghost small btn-menu" data-action="note-insert" title="Insert the open request or its response">Insert</button>' : ''}
      <button class="btn-ghost small" data-action="note-delete" title="Delete note">${icon('trash')}</button></div>
    <div class="note-tags-row"><label class="hint" for="note-tags">Tags</label>
      <input type="text" id="note-tags" list="note-tag-options" value="${esc((n.tags || []).join(', '))}" placeholder="e.g. bug, follow-up, api" spellcheck="false"/>
      <datalist id="note-tag-options">${(ctx.knownTags || []).filter((t) => !(n.tags || []).includes(t)).map((t) => `<option value="${esc([...(n.tags || []), t].join(', '))}">`).join('')}</datalist></div>
    ${ctx.preview ? `<div class="md note-preview">${markdown(n.body) || '<p class="hint">Empty</p>'}</div>`
      : `<textarea id="note-body" class="note-body" spellcheck="true" placeholder="Write in Markdown: **bold**, \`code\`, - lists, \`\`\` blocks…">${esc(n.body)}</textarea>`}
    <div class="hint note-meta">${n.projectId ? `Project: ${esc(ctx.projectName(n.projectId) || '(deleted)')}` : 'Not tied to a project'}
      · <button class="link-btn" data-action="note-link-project">${n.projectId ? 'Unlink' : p ? `Link to ${esc(p.name)}` : ''}</button>
      · edited ${esc(fmt(n.updatedAt))}</div>`;
}

// The whole Notes UI. ctx: { scope, currentProject, filter, tagBar (html), editor (html) }
export function notesShellHtml(ctx) {
  return `<div class="notes">
    <div class="notes-side">
      <div class="spec-row"><button class="btn-primary small" data-action="note-new">+ Note</button>
        <select id="notes-scope" title="Which notes to list"><option value="project" ${ctx.scope === 'project' ? 'selected' : ''}>${ctx.currentProject ? esc(ctx.currentProject.name) : 'Unassigned'}</option><option value="all" ${ctx.scope === 'all' ? 'selected' : ''}>All notes</option></select></div>
      <input type="text" id="notes-filter" placeholder="Search notes (#tag for tags)…" value="${esc(ctx.filter)}" spellcheck="false"/>
      <div id="notes-tagbar">${ctx.tagBar}</div>
      <div id="notes-list" class="notes-list"></div></div>
    <div class="notes-editor">${ctx.editor}</div></div>`;
}
