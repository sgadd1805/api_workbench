// What each data-action="…" button does. Handlers get (dataset, element, click event).
// To add a button: render it with data-action="name" in views/ and add `name` to one of these groups.
import { rowActions } from './rows.js';
import { sidebarActions } from './sidebar.js';
import { requestActions } from './request.js';
import { responseActions } from './response.js';
import { compareActions } from './compare.js';
import { envActions } from './envs.js';
import { accountActions } from './accounts.js';
import { ioActions } from './io.js';
import { historyActions } from './history.js';
import { specActions } from './specs.js';
import { searchActions, bindSearchActions } from './search.js';
import { gitActions } from './git.js';
import { terminalActions } from '../terminal.js';
import { currentActions } from './current.js';
import { layoutActions, bindActions } from './layout.js';
import { noteActions } from './notes.js';
import { tokenActions } from './tokens.js';
import { networkActions } from './envs.js';
import { taskActions } from './tasks.js';
import { runnerActions } from './runner.js';
import { loadActions } from './load.js';
import { editorActions } from '../editor.js';
import { specToolActions } from './spectools.js';
import { proxyActions } from './proxy.js';
import { protocolActions } from './protocols.js';
import { repoActions } from './repo.js';
import { configActions } from './config.js';
import { backupActions } from './backup.js';
import { mcpActions } from './mcp.js';
import { logWindowActions } from './logwindows.js';
import { actuatorActions } from './actuator.js';
import { logWatchActions } from './logwatch.js';
import { otelActions } from './otel.js';
import { pickMenuItem } from '../views/menu.js';
import { closeModal, submitModal, runModalDanger } from '../modal.js';
import { openReq, closeReqTab, newRequestTab } from './core.js';

export const ACTIONS = {
  ...rowActions, ...sidebarActions, ...requestActions, ...responseActions, ...compareActions,
  ...envActions, ...accountActions, ...ioActions, ...historyActions, ...specActions, ...searchActions, ...gitActions, ...terminalActions, ...currentActions, ...layoutActions, ...noteActions, ...tokenActions, ...networkActions, ...taskActions, ...runnerActions, ...loadActions, ...editorActions, ...specToolActions, ...proxyActions, ...protocolActions, ...repoActions, ...configActions, ...backupActions, ...mcpActions, ...logWindowActions, ...actuatorActions, ...logWatchActions, ...otelActions,
  // ---- request tab bar (views/tabs.js)
  'switch-tab'(d) { openReq(d.id); },
  'close-tab'(d) { closeReqTab(d.id); },
  'new-tab'() { newRequestTab(); },
  'menu-pick'(d) { pickMenuItem(+d.idx); },
  'modal-cancel'() { closeModal(); },
  'modal-ok'() { submitModal(); },
  'modal-danger'() { runModalDanger(); },
};

bindActions(ACTIONS);
bindSearchActions(ACTIONS);

export { openReq, sendCurrent, closeReqTab, cycleTab } from './core.js';
export { onNoteInput, onNoteChange, initNotesWindow } from './notes.js';
export { onTokenSourceInput, onTokenSourceChange } from './tokens.js';
export { onTaskInput, onTaskChange, waitForTasks } from './tasks.js';
export { onRunnerInput, onRunnerChange } from './runner.js';
export { onLoadInput } from './load.js';
export { setEncryption, loadSecretsStatus } from './layout.js';
export { applyAppearance, applyAiSetting, wireLayoutDrag, onSettingsInput, onSettingsChange, openSide, sendToTool, showShortcuts } from './layout.js';
export { onRowInput } from './rows.js';
export { pickSlot, onCompareChange } from './compare.js';
export { onViewerInput, onSnapshotInput } from './response.js';
export { onSpecToolInput, onSpecToolChange } from './spectools.js';
export { onProxyInput, onProxyChange, proxyStatusItem } from './proxy.js';
export { onProtocolInput, onProtocolChange, initStreams } from './protocols.js';
export { initRepoSync } from './repo.js';
export { checkConfig } from './config.js';
export { initLogWindows } from './logwindows.js';
export { onActuatorInput, onActuatorChange } from './actuator.js';
export { initLogWatch, onLogWatchInput } from './logwatch.js';
export { initOtel } from './otel.js';
export { selectActiveEnv, renameSelectedEnv, onNetworkInput } from './envs.js';
export { openAccounts, onAccountInput } from './accounts.js';
export { importCapture, openCapture, saveCaptureFlow, useLoginSession } from './io.js';
export { linkOperation } from './specs.js';
export { openSearch, onSearchInput, onSearchKey } from './search.js';
