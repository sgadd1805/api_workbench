// The request editor's Git tab: where the endpoint lives in the project's code and its commit history.
import { esc } from '../../shared/html.js';
import { findReq, currentProject } from '../store.js';
import { gitState, repoState } from '../git.js';
import { icon } from '../../shared/icons.js';

const fmtDate = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

// Unified diff with +/-/@@ lines coloured.
function diffHtml(text) {
  return text.split('\n').map((l) => {
    const cls = /^(\+\+\+|---)/.test(l) ? 'gd-file' : l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : l.startsWith('@@') ? 'gd-hunk' : /^(commit|Author|AuthorDate|Commit|CommitDate|diff --git)/.test(l) ? 'gd-meta' : '';
    return `<div class="${cls}">${esc(l) || ' '}</div>`;
  }).join('');
}

const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };

// Repository: current branch, uncommitted changes, branches to switch to.
function repoHtml(p) {
  const st = repoState(p.codeFolder);
  const head = `<h4 class="section-title">Repository <button class="btn-ghost small" data-action="git-repo-refresh" title="Refresh">↻</button>
    <button class="btn-ghost small" data-action="git-fetch" ${st.busy ? 'disabled' : ''} title="git fetch --all --prune">Fetch</button></h4>`;
  if (st.error) return head + `<p class="error-text">${esc(st.error)}</p>`;
  if (!st.status) return head + '<p class="hint">Loading…</p>';
  const s = st.status, cur = s.local.find((b) => b.current);
  const track = cur?.upstream ? `<span class="hint">→ ${esc(cur.upstream)}${cur.ahead ? ` ↑${cur.ahead}` : ''}${cur.behind ? ` ↓${cur.behind}` : ''}${cur.gone ? ' (upstream gone)' : ''}</span>` : '<span class="hint">no upstream</span>';
  const changes = s.changes.length ? `<details class="git-changes"><summary class="warn-text">${s.changes.length} uncommitted change${s.changes.length === 1 ? '' : 's'}</summary>
      ${s.changes.slice(0, 100).map((c) => `<div class="git-hit"><code>${esc(c.code)}</code> ${esc(c.file)}</div>`).join('')}</details>` : '<div class="hint">Working tree clean</div>';
  const row = (b) => `<div class="git-branch${b.current ? ' active' : ''}" ${b.current ? '' : `data-action="git-switch" data-branch="${esc(b.name)}"`} title="${b.current ? 'Current branch' : 'Switch to ' + esc(b.name)}">
      <span class="git-branch-name">${b.current ? '● ' : ''}${esc(b.name)}</span>
      ${b.ahead || b.behind ? `<span class="hint">${b.ahead ? '↑' + b.ahead : ''}${b.behind ? ' ↓' + b.behind : ''}</span>` : ''}
      <span class="hint git-branch-when">${esc(ago(b.date))}</span></div>`;
  const localNames = new Set(s.local.map((b) => b.name));
  const remotes = s.remote.filter((b) => !localNames.has(b.name.replace(/^[^/]+\//, '')));
  return head + `<div class="git-current"><span class="git-branch-name">⎇ ${s.detached ? 'detached HEAD' : esc(s.branch)}</span> ${track}</div>
    ${s.head ? `<div class="hint git-head"><code>${esc(s.head.short)}</code> ${esc(s.head.subject)} · ${esc(s.head.author)}, ${esc(ago(s.head.date))} ago</div>` : ''}
    ${changes}
    <div class="mt-8 spec-row"><span class="hint">Branches</span>
      <input type="text" id="git-branch-filter" placeholder="filter…" value="${esc(st.filter || '')}" spellcheck="false" class="grow"/>
      <button class="btn-ghost small" data-action="git-new-branch">+ New branch</button></div>
    <div class="git-branches">${s.local.filter((b) => !st.filter || b.name.includes(st.filter)).map(row).join('')}</div>
    ${remotes.length ? `<details class="git-remotes"${st.showRemote ? ' open' : ''}><summary class="hint" data-action="git-toggle-remote">Remote branches (${remotes.length})</summary>
      <div class="git-branches">${remotes.filter((b) => !st.filter || b.name.includes(st.filter)).map(row).join('')}</div></details>` : ''}
    ${st.busy ? `<p class="hint">${esc(st.busy)}…</p>` : ''}`;
}

// The side panel's Git tab: the repository, then this request's history.
export function gitTabHtml(r) {
  const loc = r && findReq(r.id);
  const p = loc?.p || currentProject();
  if (!p?.codeFolder) {
    return `<p class="mb-8 hint">Point this project at its code folder to see where this endpoint is defined and the commits that changed it.</p>
      <button class="btn-primary small" data-action="git-set-folder">Choose code folder…</button>`;
  }
  const folderRow = `<div class="spec-row"><span class="hint" title="${esc(p.codeFolder)}">${icon('folder')} ${esc(p.codeFolder)}</span>
      <button class="btn-ghost small" data-action="git-set-folder">Change…</button></div>`;
  if (!r) return folderRow + repoHtml(p) + '<p class="hint" style="margin-top:12px">Open a request to see the commits behind its endpoint.</p>';
  const g = gitState(r.id);
  const head = folderRow + repoHtml(p) + `<h4 class="mt-14 section-title">This request</h4>
    <div class="spec-row"><label class="hint" for="git-terms">Search code for</label>
      <input type="text" id="git-terms" value="${esc(g.terms.join(', '))}" spellcheck="false" placeholder="path template, operationId, …" class="grow"/>
      <button class="btn-ghost small" data-action="git-search">Search</button></div>`;
  if (g.loading) return head + '<p class="hint">Searching the repository…</p>';
  if (g.error) return head + `<p class="error-text">${esc(g.error)}</p>`;
  if (!g.result) return head;
  const { files, commits } = g.result;
  const filesHtml = files.length ? files.map((f) => `<div class="git-file"><code>${esc(f.file)}</code>
      ${f.hits.filter((h) => h.line).slice(0, 3).map((h) => `<div class="hint git-hit">:${h.line} ${esc(h.text)}</div>`).join('')}</div>`).join('')
    : '<p class="hint">No files mention these terms. Edit the search above (e.g. a controller\'s mapping like "/pets/{id}").</p>';
  const commitsHtml = commits.length ? commits.map((c) => `<div class="git-commit${g.selected === c.hash ? ' active' : ''}" data-action="git-show" data-hash="${esc(c.hash)}">
      <code>${esc(c.short)}</code><span class="hint">${esc(fmtDate(c.date))}</span><span class="git-author">${esc(c.author)}</span><span class="git-subject">${esc(c.subject)}</span>
      <span class="hint git-reason">${esc(c.reasons.join('; '))}</span></div>`).join('')
    : '<p class="hint">No commits found.</p>';
  const diff = g.selected ? (g.diffLoading ? '<p class="hint">Loading diff…</p>' : g.diff ? `<pre class="resp-body git-diff">${diffHtml(g.diff)}</pre>` : '') : '';
  return head + `<h4 class="section-title">Defined / mentioned in (${files.length})</h4>${filesHtml}
    <h4 class="section-title">Commits (${commits.length})</h4><div class="git-commits">${commitsHtml}</div>${diff}`;
}
