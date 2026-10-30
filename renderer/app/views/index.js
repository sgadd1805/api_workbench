// Rendering only: each render* function rebuilds one region of index.html from DB + S.
// Interactive elements carry data-action / ids that events.js dispatches on.
// S.page picks the content area: 'request' (tab bar + request/response split), 'compare', or a full-width page
// ('envs', 'accounts', 'history' entry, 'specs', 'settings'). views/layout.js draws the split, side panel and status bar.
import { $, esc } from '../../shared/html.js';
import { DB, S, currentProject } from '../store.js';
import { renderSplit, renderSidePanel, renderStatusBar } from './layout.js';
import { welcomeHtml } from './welcome.js';
import { settingsPageHtml } from './settings.js';
import { tokensPageHtml } from './tokens.js';
import { tasksPageHtml } from './tasks.js';
import { runnerPageHtml } from './runner.js';
import { loadPageHtml } from './load.js';
import { terminalState } from '../terminal.js';

const terminalOpen = () => terminalState.open;
import { renderSidebar } from './sidebar.js';
import { renderTabBar } from './tabs.js';
import { renderRequestPanel } from './request.js';
import { renderResponsePanel } from './response.js';
import { renderCompare } from './compare.js';
import { envsPageHtml } from './envs.js';
import { accountsPageHtml } from './accounts.js';
import { historyPageHtml } from './history.js';
import { specsPageHtml } from './specs.js';
import { proxyPageHtml } from './proxy.js';
import { actuatorPageHtml } from './actuator.js';
import { icon } from '../../shared/icons.js';

export { renderSidebar, renderTabBar, renderRequestPanel, renderResponsePanel, renderCompare, renderSplit, renderSidePanel, renderStatusBar };
export { refreshSideSpecSoon, registerStatusItem, toolsFrameReady, toolsFrameWindow, forgetBranch } from './layout.js';
export { refreshTabBody, jsonStatus } from './request.js';
export { renderHistoryList, historyResponse } from './history.js';

const PAGES = { envs: envsPageHtml, accounts: accountsPageHtml, history: historyPageHtml, specs: specsPageHtml, settings: settingsPageHtml, tokens: tokensPageHtml, tasks: tasksPageHtml, runner: runnerPageHtml, load: loadPageHtml, proxy: proxyPageHtml, actuator: actuatorPageHtml };

export function renderTopbar() {
  const p = currentProject(), l = DB.settings.layout;
  const mac = navigator.platform.startsWith('Mac');
  const envSelect = p
    ? `<label class="hint" for="env-select">Env</label><select id="env-select" title="Active environment for ${esc(p.name)}">
        <option value="">No environment</option>${p.envs.map((e) => `<option value="${esc(e.id)}" ${e.id === p.activeEnv ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>`
    : '';
  const toggle = (action, label, on, title) => `<button class="btn-ghost small${on ? ' compare-active' : ''}" data-action="${action}" title="${esc(title)}" aria-pressed="${on}">${label}</button>`;
  $('topbar').innerHTML = `<span class="app-title"><img class="app-logo" src="assets/logo.svg" alt="" />API Workbench</span>
    <button class="topbar-search" data-action="open-search" title="Search requests, API operations and commands">${icon('search')} Search <span class="hint">${mac ? '⌘K' : 'Ctrl+K'}</span></button>
    <div class="topbar-right">${envSelect}
      <button class="btn-ghost small btn-menu" data-action="menu-project" ${p ? '' : 'disabled'} title="Environments, specs, settings, export">Project</button>
      <button class="btn-ghost small btn-menu" data-action="menu-import" title="cURL, collections, specs, captured traffic">Import</button>
      <span class="topbar-sep"></span>
      ${toggle('toggle-compare', 'Compare', S.page === 'compare', 'Compare two requests side by side')}
      ${toggle('term-toggle', 'Terminal', terminalOpen(), 'Run commands (Ctrl+`)')}
      ${toggle('side-toggle-notes', 'Notes', l.sideOpen && l.sideTab === 'notes', 'Notes in the side panel')}
      ${toggle('side-toggle-tools', 'Tools', l.sideOpen && l.sideTab === 'tools', 'JWT, Base64, JSON, Diff… in the side panel')}
      ${toggle('session-toggle', 'Session', l.session, 'Login window, test accounts and capture')}
      <button class="btn-ghost small" data-action="open-settings" title="Settings" aria-label="Settings">${icon('gear')}</button>
    </div>`;
}

export function renderPage() {
  const el = $('page-panel');
  const html = PAGES[S.page];
  el.style.display = html ? '' : 'none';
  el.innerHTML = html ? html() : '';
  const welcome = $('welcome');
  const showWelcome = S.page === 'request' && !S.req;
  welcome.style.display = showWelcome ? '' : 'none';
  if (showWelcome) welcome.innerHTML = welcomeHtml();
  document.getElementById('dev-toolbar').hidden = !DB.settings.layout.session;
}

export function renderAll() {
  renderTopbar(); renderSidebar(); renderTabBar(); renderPage(); renderSplit(); renderRequestPanel(); renderResponsePanel();
  renderCompare(); renderSidePanel(); renderStatusBar();
}
