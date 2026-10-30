// Specs page extras: drift check, breaking-change diff against git history, mock server.
import { copyText, flashDone } from '../../shared/html.js';
import { notify } from '../../shared/notify.js';
import { S, saveDB, currentProject, addEnv } from '../store.js';
import { specAnalysis, ensureProjectSpecs } from '../openapi/registry.js';
import { driftCheck } from '../openapi/drift.js';
import { diffSpecs } from '../openapi/diff.js';
import { mockRoutes, mockBasePath } from '../openapi/mock.js';
import { renderAll, renderPage } from '../views/index.js';
import { openModal } from '../modal.js';

const api = window.electronAPI;
const T = () => S.specTools;
const metaFor = (id) => currentProject()?.specs.find((s) => s.id === id);
const fmtDate = (iso) => new Date(iso).toLocaleDateString([], { dateStyle: 'medium' });

let hitsWired = false;
function wireHits() {
  if (hitsWired) return;
  hitsWired = true;
  api.onMockHit((h) => {
    const m = T().mock[h.id]; if (!m) return;
    m.hits.unshift(h); m.hits.length = Math.min(m.hits.length, 200);
    if (S.page === 'specs' && T().mockOpen === h.id) renderPage();
  });
}

const routesFor = (id) => mockRoutes(specAnalysis(id), T().mock[id]?.overrides || {});
const pushUpdate = (id, extra = {}) => { if (T().mock[id]?.running) api.mockUpdate({ id, routes: routesFor(id), ...extra }); };

export const specToolActions = {
  async 'spec-drift'() {
    const p = currentProject(); if (!p) return;
    if (!p.specs.length) return notify('Attach a spec first', 'error');
    await ensureProjectSpecs(p);
    const responses = Object.fromEntries(S.tabs.filter((t) => t.response).map((t) => [t.id, t.response]));
    T().drift = driftCheck(p, responses);
    renderPage();
  },
  'spec-tool-close'(d) { if (d.tool === 'mock') T().mockOpen = null; else T()[d.tool] = null; renderPage(); },

  async 'spec-diff'(d) {
    const meta = metaFor(d.id); if (!meta) return;
    const res = await api.gitFileVersions(meta.source.location);
    if (!res.ok) return notify(`Git history unavailable: ${res.error}`, 'error', 7000);
    if (!res.commits.length) return notify('No commits touch this file yet', 'error');
    const options = res.commits.map((c) => ({ value: `${c.hash}|${c.path}`, label: `${c.short} · ${fmtDate(c.date)} · ${c.subject.slice(0, 70)}` }));
    openModal({ title: `Compare ${meta.title} with…`, ok: 'Compare', wide: true,
      hint: 'The file as it is now on disk is compared with the chosen commit; the newer side is "after".',
      fields: [{ key: 'commit', label: 'Earlier version (commit)', type: 'select', options, value: options[Math.min(1, options.length - 1)].value }],
      onOk: async (v) => {
        const [hash, rel] = v.commit.split('|');
        const [old, now] = await Promise.all([api.gitFileAt(meta.source.location, hash, rel), api.specsRead(meta.source.location)]);
        if (!old.ok) return notify(old.error, 'error');
        if (!now.ok) return notify(`Could not read the current file: ${now.error}`, 'error');
        const parsed = await api.specsParse(old.text, rel);
        if (!parsed.ok) return notify(`That version isn't a readable spec: ${parsed.error}`, 'error');
        const commit = res.commits.find((c) => c.hash === hash);
        try {
          T().diff = { specId: meta.id, title: meta.title, from: `${commit.short} (${fmtDate(commit.date)})`, to: 'working copy', changes: diffSpecs(parsed.doc, now.doc) };
        } catch (err) { return notify('Could not compare: ' + err.message, 'error'); }
        renderPage();
      } });
  },

  'mock-open'(d) {
    wireHits();
    T().mockOpen = d.id;
    T().mock[d.id] ||= { running: false, delayMs: 0, override: '', overrides: {}, hits: [] };
    renderPage();
  },
  async 'mock-start'(d) {
    const meta = metaFor(d.id), m = T().mock[d.id], analysis = specAnalysis(d.id); if (!meta || !m || !analysis) return;
    const port = parseInt(document.getElementById('mock-port')?.value, 10) || 0;
    const res = await api.mockStart({ id: d.id, routes: routesFor(d.id), port, delayMs: m.delayMs, basePath: mockBasePath(analysis), override: m.override });
    if (!res.ok) return notify(res.error, 'error');
    Object.assign(m, { running: true, port: res.port, url: res.url });
    if (port) { meta.mockPort = port; saveDB(); }
    notify(`Mock server on ${res.url}`);
    renderPage();
  },
  async 'mock-stop'(d) {
    await api.mockStop(d.id);
    Object.assign(T().mock[d.id] || {}, { running: false });
    renderPage();
  },
  'mock-env'(d) {
    const p = currentProject(), m = T().mock[d.id]; if (!p || !m?.url) return;
    const env = p.envs.find((e) => e.name === 'mock') || addEnv(p, 'mock');
    const row = env.vars.find((x) => x.k === 'baseUrl');
    if (row) Object.assign(row, { v: m.url, on: true }); else env.vars.push({ k: 'baseUrl', v: m.url, on: true });
    p.activeEnv = env.id;
    saveDB(); renderAll();
    notify('Environment "mock" is active: {{baseUrl}} points at the mock server');
  },
  'copy-text'(d, el) { copyText(d.text || ''); flashDone(el); },
};

// Inputs on the mock panel.
export function onSpecToolInput(el) {
  const id = T().mockOpen, m = id && T().mock[id]; if (!m) return false;
  if (el.id === 'mock-delay') { m.delayMs = Math.max(0, Math.min(60000, parseInt(el.value, 10) || 0)); pushUpdate(id, { delayMs: m.delayMs }); return true; }
  return el.id === 'mock-port';
}
export function onSpecToolChange(el) {
  const id = T().mockOpen, m = id && T().mock[id]; if (!m) return false;
  if (el.id === 'mock-all') { m.override = el.value; if (m.running) api.mockUpdate({ id, override: m.override }); return true; }
  if (el.classList.contains('mock-ov')) {
    if (el.value) m.overrides[el.dataset.op] = el.value; else delete m.overrides[el.dataset.op];
    pushUpdate(id);
    return true;
  }
  return false;
}
