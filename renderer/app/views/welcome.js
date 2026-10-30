// The empty state: quick actions and recently sent requests.
import { esc } from '../../shared/html.js';
import { DB, findReq, methodLabel } from '../store.js';
import { historyEntries } from '../history.js';

const mac = () => navigator.platform.startsWith('Mac');

export function welcomeHtml() {
  const seen = new Set();
  const recent = [];
  for (const e of historyEntries()) {
    if (!e.reqId || seen.has(e.reqId) || !findReq(e.reqId)) continue;
    seen.add(e.reqId); recent.push(findReq(e.reqId));
    if (recent.length >= 8) break;
  }
  const action = (act, title, text) => `<button class="btn-ghost" data-action="${act}"><b>${title}</b><span class="hint">${text}</span></button>`;
  return `<h2>API Workbench</h2>
    <div class="welcome-actions">
      ${action('welcome-new-project', 'New project', 'Group requests, environments and specs')}
      ${action('import-collection', 'Import a collection', 'This app\'s export or a Postman collection')}
      ${action('welcome-find-specs', 'Find specs in a code folder', 'Swagger / OpenAPI files → requests')}
      ${action('open-search', `Search APIs <span class="kbd">${mac() ? '⌘K' : 'Ctrl+K'}</span>`, 'Requests, operations and commands')}
    </div>
    ${recent.length ? `<div class="welcome-recent"><div class="hint" style="margin-bottom:4px">Recent</div>${recent.map(({ p, r }) =>
      `<div class="sidebar-item request-item" data-action="open-req" data-id="${esc(r.id)}"><span class="method-tag m-${esc(methodLabel(r))}">${esc(methodLabel(r))}</span>
        <span class="item-name">${esc(r.name)}</span><span class="hint">${esc(p.name)}</span></div>`).join('')}</div>`
      : DB.projects.length ? '<p>Open a request from the sidebar, or create one.</p>' : '<p>Create a project to get started.</p>'}
    <p class="hint">Press <span class="kbd">?</span> for keyboard shortcuts.</p>`;
}
