// The ⌘K palette: saved requests, spec operations, actions, and every setting and page (actions/palette.js).
// Typing ">" first searches only actions, settings and pages; ">" alone lists them all.
// Open/close, typing, keyboard navigation, and running a result.
import { DB, S, saveDB, project, allRequests } from '../store.js';
import { searchItems, searchApi } from '../search.js';
import { specAnalysis, ensureProjectSpecs } from '../openapi/registry.js';
import { renderSearch, renderSearchResults } from '../views/search.js';
import { openReq } from './core.js';
import { requestForOperation } from './specs.js';
import { currentProject } from '../store.js';
import { selectActiveEnv } from './envs.js';
import { settingItems } from './palette.js';

// Actions offered in the palette alongside requests and operations. ACTIONS comes from actions/index.js.
let ACTIONS_REF = {};
export const bindSearchActions = (a) => { ACTIONS_REF = a; };
const mac = navigator.platform.startsWith('Mac');
function commandItems() {
  const run = (name, d = {}) => () => ACTIONS_REF[name]?.(d, document.body, { target: document.body });
  const p = currentProject();
  const cmds = [
    ['New request', 'new-tab', '', 'create add'],
    ['Toggle terminal', 'term-toggle', 'Ctrl+`', 'shell console bash cmd'],
    ['Load test this request…', 'open-load', '', 'performance stress concurrency latency p95'],
    ['Import cURL…', 'import-curl', '', ''],
    ['Import a HAR file into the Network list…', 'import-har', '', 'har devtools chrome firefox network capture'],
    ['Copy request as code…', 'copy-code', '', 'snippet fetch axios python java csharp c# restclient httpclient curl'],
    ['Import collection file…', 'import-collection', '', 'postman'],
    ['Export project…', 'export-collection', '', 'postman'],
    ['Save requests to repo', 'repo-save', '', 'git files yaml commit share team'],
    ['Load requests from repo…', 'repo-load', '', 'git files yaml pull share team'],
    ['Apply api-client.json', 'config-apply', '', 'config setup ai agent import'],
    ['Export as api-client.json', 'config-export', '', 'config setup export save repo'],
    ['Import requests from an api-client.json', 'config-import-requests', '', 'config import requests pick'],
    ['Back up everything', 'backup-create', '', 'backup export save all data'],
    ['Restore from backup', 'backup-restore', '', 'backup restore import'],
    ['Undo the last edit', 'undo-edit', mac ? '⌘Z' : 'Ctrl+Z', 'undo revert back'],
    ['Redo', 'redo-edit', mac ? '⌘⇧Z' : 'Ctrl+Y', 'redo again'],
    ['Keyboard shortcuts', 'shortcuts', '?', 'help keys'],
  ].map(([title, action, hint, keywords]) => ({ kind: 'command', title, hint, keywords, run: run(action) }));
  for (const e of p?.envs || []) cmds.push({ kind: 'command', group: 'Environment', title: `Switch environment: ${e.name}`, hint: e.id === p.activeEnv ? 'active' : '', keywords: 'env', run: () => selectActiveEnv(e.id) });
  return cmds;
}

let items = [];
const isCommand = (item) => item.kind === 'command' || item.kind === 'setting' || item.kind === 'page';
const commandsAndSettings = () => [...commandItems(), ...settingItems(ACTIONS_REF)];

// The palette's results for a query: ">" keeps to actions, settings and pages, and ">" alone lists them all.
export function paletteResults(list, query) {
  if (!query.startsWith('>')) return searchApi(list, query);
  const rest = query.slice(1).trim(), cmds = list.filter(isCommand);
  return rest ? searchApi(cmds, rest, 300) : cmds;
}

export async function openSearch(query) {
  S.search.open = true; S.search.selected = 0;
  if (query !== undefined) S.search.query = query;
  // Index everything: specs of every project, not only the current one.
  await Promise.all(DB.projects.map((p) => ensureProjectSpecs(p)));
  items = [...searchItems(DB.projects, specAnalysis), ...commandsAndSettings()];
  S.search.results = paletteResults(items, S.search.query);
  renderSearch();
  const input = document.getElementById('api-search-input');
  if (query !== undefined) { input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); } else input?.select();
}

export function closeSearch() { S.search.open = false; renderSearch(); }

export function onSearchInput(value) {
  S.search.query = value; S.search.selected = 0;
  S.search.results = paletteResults(items, value);
  renderSearchResults();
}

// ↑ / ↓ / Enter / Esc inside the search box. → true when handled.
export function onSearchKey(e) {
  const n = S.search.results.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (n) S.search.selected = (S.search.selected + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderSearchResults(); return true;
  }
  if (e.key === 'Enter') { pick(S.search.selected); return true; }
  if (e.key === 'Escape') { closeSearch(); return true; }
  return false;
}

async function pick(i) {
  const item = S.search.results[i]; if (!item) return;
  if (item.keepOpen) {
    // A toggle: apply it, then show the palette again with the new state, still on the same item.
    await item.run();
    items = [...items.filter((x) => !isCommand(x)), ...commandsAndSettings()];
    S.search.results = paletteResults(items, S.search.query);
    S.search.selected = Math.min(i, S.search.results.length - 1);
    renderSearch();
    const input = document.getElementById('api-search-input'); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length);
    return;
  }
  closeSearch();
  if (isCommand(item)) return item.run();
  if (item.kind === 'request') return openReq(item.id);
  // An operation: open the request already linked to it, else create one (in the tag's folder).
  const p = project(item.projectId);
  const existing = allRequests(p).find((r) => r.spec?.specId === item.specId && r.spec.opKey === item.opKey);
  if (existing) return openReq(existing.id);
  const r = requestForOperation(p, p.specs.find((s) => s.id === item.specId), specAnalysis(item.specId).byKey.get(item.opKey));
  saveDB(); openReq(r.id);
}

export const searchActions = {
  'open-search'() { openSearch(); },
  'open-commands'() { openSearch('>'); },
  'search-pick'(d) { pick(+d.idx); },
  // Clicking the dimmed backdrop (not the box) closes the palette.
  'search-close-backdrop'(_d, el, e) { if (e.target === el) closeSearch(); },
};
