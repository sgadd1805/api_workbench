// Notes tags and the shared notes rendering (shared/notesview.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseTags, allTags, filterNotes, notesListHtml, tagBarHtml, noteEditorHtml } = await import('../renderer/shared/notesview.js');
const n = (id, title, tags = [], projectId = null, body = '') => ({ id, title, body, tags, projectId, createdAt: 1, updatedAt: 1 });

test('parseTags: commas, #, spaces, case, duplicates, junk', () => {
  assert.deepEqual(parseTags('Bug, #API  ,follow up'), ['bug', 'api', 'follow-up']);
  assert.deepEqual(parseTags('#a #b, a'), ['a', 'b']);
  assert.deepEqual(parseTags('<script>, ok!'), ['script', 'ok']);
  assert.deepEqual(parseTags('  ,, '), []);
  assert.deepEqual(parseTags('v1.2/x_y'), ['v1.2/x_y']);
});

test('allTags counts, filterNotes by scope, tag, text and #tag words', () => {
  const notes = [n('1', 'Login bug', ['bug', 'auth'], 'P1'), n('2', 'Ideas', ['idea'], null, 'faster tokens'), n('3', 'Other project', ['bug'], 'P2')];
  assert.deepEqual(allTags(notes), [{ tag: 'bug', count: 2 }, { tag: 'auth', count: 1 }, { tag: 'idea', count: 1 }]);
  const ids = (o) => filterNotes(notes, o).map((x) => x.id);
  assert.deepEqual(ids({ scope: 'project', projectId: 'P1' }), ['1', '2']);
  assert.deepEqual(ids({ scope: 'all', tag: 'bug' }), ['1', '3']);
  assert.deepEqual(ids({ scope: 'all', filter: '#bug login' }), ['1']);
  assert.deepEqual(ids({ scope: 'all', filter: 'token' }), ['2']);
  assert.deepEqual(ids({ scope: 'all', filter: 'aut' }), ['1']); // partial tag match
  assert.deepEqual(ids({ scope: 'all', filter: '#au' }), []);    // #tag must be a whole tag
});

test('rendering: tag chips, tag bar state, escaping, editor tag field', () => {
  const notes = [n('1', '<b>x</b>', ['bug'])];
  const html = notesListHtml(notes, { activeId: '1', showProject: false, projectName: () => '', total: 1 });
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /<span class="note-tag">#bug<\/span>/);
  assert.equal(notesListHtml([], { total: 3 }).includes('No matching notes'), true);
  assert.equal(tagBarHtml([], ''), '');
  const bar = tagBarHtml(allTags(notes), 'bug');
  assert.match(bar, /data-tag="bug" aria-pressed="true"/);
  assert.match(noteEditorHtml(notes[0], { preview: false, projectName: () => '', currentProject: null, knownTags: ['bug', 'api'] }), /id="note-tags"[^>]*value="bug"[\s\S]*<option value="bug, api">/);
});
