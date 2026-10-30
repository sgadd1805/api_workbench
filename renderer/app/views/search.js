// The API search palette (S.search), drawn over the app in #search-root.
import { $, esc } from '../../shared/html.js';
import { S } from '../store.js';

const KIND_LABEL = { command: 'action', setting: 'setting', page: 'go to' };
// A setting's current value at the right: on / off as a pill, anything else as text.
const stateHtml = (state) => (!state ? '' : state === 'on' || state === 'off' ? `<span class="search-state ${state}">${state}</span>`
  : state.startsWith('on ') ? `<span class="search-state on">${esc(state)}</span>` : `<span class="hint search-state-text">${esc(state)}</span>`);

function resultHtml(item, i) {
  if (item.kind === 'command' || item.kind === 'setting' || item.kind === 'page') {
    return `<div class="search-result${i === S.search.selected ? ' selected' : ''}" data-action="search-pick" data-idx="${i}">
      <div class="search-line"><span class="search-kind cmd ${item.kind}">${KIND_LABEL[item.kind]}</span>${item.group ? `<span class="hint search-group">${esc(item.group)}</span>` : ''}<span class="search-title">${esc(item.title)}</span>
        <span class="search-right">${item.hint ? `<span class="hint">${esc(item.hint)}</span>` : ''}${stateHtml(item.state)}</span></div></div>`;
  }
  const kind = item.kind === 'request' ? '<span class="search-kind">request</span>' : '<span class="search-kind op">operation</span>';
  const where = item.kind === 'request' ? `${item.projectName}${item.folder ? ' / ' + item.folder : ''}` : `${item.projectName} · ${item.specTitle}${item.tags ? ' · ' + item.tags : ''}`;
  return `<div class="search-result${i === S.search.selected ? ' selected' : ''}" data-action="search-pick" data-idx="${i}">
    <div class="search-line">${kind}<span class="method-tag m-${esc(item.method)}">${esc(item.method)}</span><code class="search-path">${esc(item.path)}</code>
      ${item.title ? `<span class="search-title">${esc(item.title)}</span>` : ''}${item.deprecated ? '<span class="warn-text">deprecated</span>' : ''}</div>
    <div class="hint search-where">${esc(where)}${item.snippet ? ` — ${esc(item.snippet)}` : ''}</div></div>`;
}

export function renderSearchResults() {
  const list = $('search-results'); if (!list) return;
  const { query, results } = S.search;
  list.innerHTML = results.length ? results.map(resultHtml).join('')
    : `<div class="hint" style="padding:12px">${query.trim() ? 'Nothing matches' : 'Type to search saved requests, API spec operations (path, name, summary, operationId, tag, parameter, description), actions, settings and pages, e.g. “dark theme”, “wrap”, “proxy”, “switch environment”. Start with &gt; for only actions, settings and pages; &gt; alone lists them all.'}</div>`;
  list.querySelector('.search-result.selected')?.scrollIntoView({ block: 'nearest' });
}

export function renderSearch() {
  const root = $('search-root');
  if (!S.search.open) { root.innerHTML = ''; return; }
  root.innerHTML = `<div class="overlay search-overlay" data-action="search-close-backdrop"><div class="search-box">
      <input type="text" id="api-search-input" placeholder="Search requests, APIs, actions and settings…  (&gt; for settings only · ↑↓ · Enter · Esc)" spellcheck="false" autocomplete="off" value="${esc(S.search.query)}"/>
      <div id="search-results" class="search-results"></div></div></div>`;
  renderSearchResults();
  $('api-search-input').focus();
}
