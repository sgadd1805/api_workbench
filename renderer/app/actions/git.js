// Git tab: choose the project's code folder, search the repository, show a commit's diff.
import { notify } from '../../shared/notify.js';
import { DB, S, saveDB, findReq, currentProject } from '../store.js';
import { buildRequest } from '../http.js';
import { ensureProjectSpecs, operationFor } from '../openapi/registry.js';
import { gitState, defaultTerms, repoState } from '../git.js';
import { openModal } from '../modal.js';
import { renderSidePanel, renderStatusBar, forgetBranch } from '../views/index.js';

// The Git tab lives in the side panel.
const gitVisible = () => DB.settings.layout.sideOpen && DB.settings.layout.sideTab === 'git';
const rerenderIfOpen = (reqId) => { if (S.req?.id === reqId && gitVisible()) renderSidePanel(); };

// Load the Git tab for the open request: default terms from its spec operation (or URL), then search.
export async function loadGit(reqId, { force = false } = {}) {
  const loc = findReq(reqId); if (!loc?.p.codeFolder) return;
  const g = gitState(reqId);
  if (g.loading || (g.result && !force)) return;
  if (!g.terms.length) {
    await ensureProjectSpecs(loc.p);
    let wire; try { wire = buildRequest(loc); } catch { wire = { method: loc.r.method, url: loc.r.url }; }
    const m = operationFor(loc, wire.method, wire.url);
    g.terms = defaultTerms({ op: m?.op, basePath: m?.analysis.basePaths[0], url: wire.url });
  }
  if (!g.terms.length) { g.error = 'Enter something to search the code for (e.g. the endpoint path).'; return rerenderIfOpen(reqId); }
  g.loading = true; g.error = null; rerenderIfOpen(reqId);
  const specFiles = loc.p.specs.filter((s) => s.source.type === 'file').map((s) => s.source.location);
  const res = await window.electronAPI.gitRequestHistory({ folder: loc.p.codeFolder, terms: g.terms, extraFiles: specFiles });
  g.loading = false;
  if (res.ok) { g.result = res; g.selected = null; g.diff = null; } else { g.error = res.error; g.result = null; }
  rerenderIfOpen(reqId);
}

// ---- repository panel (branch, changes, switching)
const repoFolder = () => (S.req && findReq(S.req.id)?.p.codeFolder) || currentProject()?.codeFolder || '';

export async function loadRepo({ force = false } = {}) {
  const folder = repoFolder(); if (!folder) return;
  const st = repoState(folder);
  if (st.loading || (st.status && !force)) return;
  st.loading = true;
  const res = await window.electronAPI.gitStatus(folder);
  st.loading = false;
  if (res.ok) { st.status = res; st.error = null; } else { st.error = res.error; st.status = null; }
  if (gitVisible()) renderSidePanel();
}

// Runs a branch-changing git command, then refreshes the panel and the status bar's branch.
async function repoOp(label, call) {
  const folder = repoFolder(), st = repoState(folder);
  st.busy = label; renderSidePanel();
  const res = await call(folder);
  st.busy = '';
  if (res.ok) { st.status = res; st.error = null; notify(`${label}: done — on ${res.branch}`); }
  else notify(`${label} failed: ${res.error}`, 'error', 10000);
  forgetBranch(folder); renderStatusBar(); renderSidePanel();
}

function switchTo(branch) {
  repoOp(`Switch to ${branch}`, (folder) => window.electronAPI.gitCheckout({ folder, branch }));
}

export const gitActions = {
  'git-repo-refresh'() { loadRepo({ force: true }); },
  'git-fetch'() { repoOp('Fetch', (folder) => window.electronAPI.gitFetch(folder)); },
  'git-toggle-remote'() { const st = repoState(repoFolder()); st.showRemote = !st.showRemote; },
  'git-switch'(d) {
    const changes = repoState(repoFolder()).status?.changes || [];
    if (!changes.length) return switchTo(d.branch);
    // Git carries uncommitted changes across (or refuses if they conflict) — say so before switching.
    openModal({ title: `Switch to ${d.branch}?`, ok: 'Switch', fields: [],
      hint: `You have ${changes.length} uncommitted change${changes.length === 1 ? '' : 's'}. Git keeps them in the working tree when they don't conflict with ${d.branch}, and refuses to switch if they do.`,
      onOk: () => switchTo(d.branch) });
  },
  'git-new-branch'() {
    const current = repoState(repoFolder()).status?.branch || '';
    openModal({ title: 'New branch', ok: 'Create and switch', fields: [
      { key: 'name', label: 'Name', value: '' },
      { key: 'from', label: 'Start from (branch or commit; empty = current)', value: current }],
    onOk: (v) => {
      const name = v.name.trim(); if (!name) return;
      repoOp(`Create ${name}`, (folder) => window.electronAPI.gitCheckout({ folder, branch: name, create: true, from: v.from.trim() === current ? '' : v.from.trim() }));
    } });
  },
  async 'git-set-folder'() {
    const loc = S.req && findReq(S.req.id);
    const p = loc?.p; if (!p) return;
    const folder = await window.electronAPI.pickFolder(); if (!folder) return;
    const info = await window.electronAPI.gitInfo(folder);
    p.codeFolder = folder; saveDB();
    if (!info.ok) notify(`${folder} is not inside a git repository (${info.error}); git history won't be available`, 'error', 8000);
    gitState(loc.r.id).result = null;
    renderSidePanel(); loadGit(loc.r.id, { force: true });
  },
  'git-search'() {
    const g = gitState(S.req.id);
    g.terms = (document.getElementById('git-terms')?.value || '').split(',').map((t) => t.trim()).filter(Boolean);
    loadGit(S.req.id, { force: true });
  },
  async 'git-show'(d) {
    const loc = findReq(S.req.id), g = gitState(S.req.id);
    if (g.selected === d.hash) { g.selected = null; return renderSidePanel(); } // click again to collapse
    g.selected = d.hash; g.diffLoading = true; g.diff = null; renderSidePanel();
    const files = g.result?.files.map((f) => f.file) || [];
    const res = await window.electronAPI.gitShow({ folder: loc.p.codeFolder, hash: d.hash, files });
    g.diffLoading = false; g.diff = res.ok ? res.text : `Could not load diff: ${res.error}`;
    rerenderIfOpen(loc.r.id);
  },
};

// Typing in the branch filter: re-render the panel but keep the cursor in the box.
export function filterBranches(value) {
  repoState(repoFolder()).filter = value;
  renderSidePanel();
  const el = document.getElementById('git-branch-filter');
  if (el) { el.focus(); el.setSelectionRange(value.length, value.length); }
}
