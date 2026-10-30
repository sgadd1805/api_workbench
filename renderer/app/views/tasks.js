// Tasks page: local services under test and log sources, with a live log view. Also the log-line
// renderer used by the response's Logs tab.
import { $, esc } from '../../shared/html.js';
import { S, currentProject } from '../store.js';
import { taskInfo, logLines, sourceParts, SEARCHABLE } from '../tasks.js';
import { hitsFor } from '../logwatch.js';
import { kvRows } from './kv.js';
import { icon } from '../../shared/icons.js';
import { stateChip, logEntriesHtml, searchFormHtml, searchResultsHtml, LEVEL_RANK } from '../../shared/logview.js';

export { stateChip, logEntriesHtml, searchResultsHtml, LEVEL_RANK };

function taskEditor(t) {
  const field = (key, label, ph, extra = '') => `<div class="spec-row"><label class="hint net-label" for="task-${key}">${label}</label><input type="text" id="task-${key}" value="${esc(t[key] || '')}" placeholder="${esc(ph)}" spellcheck="false" class="grow" ${extra}/></div>`;
  return `<details class="task-editor"${S.tasks.editing || !t.command ? ' open' : ''}><summary class="section-title" style="cursor:pointer" data-action="task-edit-toggle">Settings</summary>
    ${field('name', 'Name', 'e.g. pets-service')}
    <div class="spec-row"><label class="hint net-label" for="task-command">Command</label><input type="text" id="task-command" value="${esc(t.command)}" placeholder="./mvnw spring-boot:run" spellcheck="false" class="grow mono"/>
      <button class="btn-ghost small" data-action="task-detect" title="Suggest a command from the code folder">Detect…</button></div>
    ${field('cwd', 'Folder', 'relative to the project\'s code folder, or absolute (empty = code folder)')}
    ${field('profile', 'Spring profile', 'e.g. local → SPRING_PROFILES_ACTIVE')}
    ${field('jvmOpts', 'JVM options', '-Xmx1g -Dserver.port=8081 → JAVA_TOOL_OPTIONS')}
    ${field('javaHome', 'JAVA_HOME', 'JDK folder (empty = the one on PATH)')}
    ${field('readyLog', 'Ready when log', 'regex; default: Spring Boot\'s "Started … in … seconds"')}
    ${field('readyUrl', 'Ready when URL', 'e.g. http://localhost:8080/actuator/health')}
    <div class="spec-row"><span class="net-label"></span><label><input type="checkbox" id="task-waitForReady" ${t.waitForReady ? 'checked' : ''}/> Hold sends until it's ready</label></div>
    <h4 class="section-title">Environment variables</h4>${kvRows(t.env, 'task-env')}
    <div class="mt-8"><button class="btn-ghost small" data-action="task-delete">Delete task</button></div></details>`;
}

const SOURCE_TYPES = [['ssh', 'Server (SSH)'], ['kubernetes', 'Kubernetes'], ['docker', 'Docker'], ['file', 'File on this computer'], ['command', 'Command']];

function sourceEditor(s) {
  const parts = sourceParts(s);
  const field = (id, label, value, ph, extra = '') => `<div class="spec-row"><label class="hint net-label" for="ls-${id}">${label}</label><input type="text" id="ls-${id}" value="${esc(value || '')}" placeholder="${esc(ph)}" spellcheck="false" class="grow" ${extra}/></div>`;
  const byType = {
    ssh: `${field('ssh-host', 'Host', parts.ssh.host, 'api-1.example.com, or a Host alias from ~/.ssh/config')}
      ${field('ssh-user', 'User', parts.ssh.user, 'empty = your ssh config / login name')}
      ${field('ssh-port', 'Port', parts.ssh.port, '22')}
      ${field('ssh-identityFile', 'Key file', parts.ssh.identityFile, 'empty = your ssh agent / default keys')}
      ${field('ssh-paths', 'Log files', parts.ssh.paths, '/var/log/pets/app.log  (comma separated; * allowed, e.g. /var/log/pets/app.log*)', 'class="grow mono"')}
      <p class="hint">Uses the system <code>ssh</code> with your keys, agent and <code>~/.ssh/config</code> (jump hosts work). It never asks for a password, so set up key login first.
        Follow runs <code>tail -F</code>; Search runs <code>grep</code> on the server, including rotated <code>.gz</code> files your paths match.</p>`,
    kubernetes: `${field('k8s-context', 'Context', parts.k8s.context, 'empty = current kubectl context')}
      ${field('k8s-namespace', 'Namespace', parts.k8s.namespace, 'empty = the context\'s default')}
      ${field('k8s-target', 'Target', parts.k8s.target, 'deploy/pets  ·  pod/pets-7d9c…  ·  statefulset/db')}
      ${field('k8s-selector', 'or selector', parts.k8s.selector, 'app=pets  (all matching pods, lines prefixed with the pod)')}
      ${field('k8s-container', 'Container', parts.k8s.container, 'empty = default container')}
      <p class="hint">Uses your <code>kubectl</code> and its credentials. Search fetches the chosen time window (<code>--since</code>) and filters it here.</p>`,
    docker: `${field('docker-container', 'Container', parts.docker.container, 'container name or id')}
      <p class="hint">Uses your <code>docker</code> CLI (also a remote one via <code>DOCKER_HOST</code> / contexts).</p>`,
    file: `<div class="spec-row"><label class="hint net-label" for="ls-path">File</label><input type="text" id="ls-path" value="${esc(s.path)}" placeholder="/var/log/app.log  (Search also takes a * pattern: /var/log/app.log*)" spellcheck="false" class="grow"/><button class="btn-ghost small" data-action="ls-browse">Browse…</button></div>`,
    command: `<div class="spec-row"><label class="hint net-label" for="ls-command">Command</label><input type="text" id="ls-command" value="${esc(s.command)}" placeholder="any command that prints a log, e.g. journalctl -fu pets" spellcheck="false" class="grow mono"/></div>
      <p class="hint">Only the live lines of a command can be filtered; use a Server, Kubernetes, Docker or File source to search older logs.</p>`,
  };
  return `<details class="task-editor"${S.tasks.editing || !isConfigured(s) ? ' open' : ''}><summary class="section-title" style="cursor:pointer" data-action="task-edit-toggle">Settings</summary>
    ${field('name', 'Name', s.name, 'e.g. pets on prod')}
    <div class="spec-row wrap"><span class="hint net-label">Type</span>
      ${SOURCE_TYPES.map(([v, label]) => `<label class="mr-10"><input type="radio" name="ls_type" value="${v}" ${s.type === v ? 'checked' : ''}/> ${label}</label>`).join('')}</div>
    ${byType[s.type] || ''}
    <div class="mt-6"><button class="btn-ghost small" data-action="ls-delete">Delete log source</button></div></details>`;
}

const isConfigured = (s) => { const x = sourceParts(s); return { ssh: x.ssh.host && x.ssh.paths, kubernetes: x.k8s.target || x.k8s.selector, docker: x.docker.container, file: s.path, command: s.command }[s.type]; };

// ---- search
function searchForm(p, sel) {
  const q = S.tasks.search;
  const searchable = p.logSources.filter((x) => SEARCHABLE.has(x.type));
  const canSource = sel.kind === 'source' && SEARCHABLE.has(sel.item.type);
  const scope = canSource ? q.scope : 'all';
  const hasWindow = (scope === 'all' ? searchable : [sel.item]).some((x) => x.type === 'kubernetes' || x.type === 'docker');
  const scopes = [...(canSource ? [{ value: 'source', label: sel.item.name }] : []), { value: 'all', label: `All searchable sources (${searchable.length})` }];
  return searchFormHtml(q, { hasWindow, scopes, scope, disabled: !searchable.length })
    + (searchable.length ? '' : '<p class="hint">Add a Server, Kubernetes, Docker or File log source to search logs where they live.</p>');
}


// Log watch: the project's rules and the lines they flagged (newest first), across its tasks and sources.
function flaggedHtml(p) {
  const w = p.logWatch || { levels: true, patterns: '', notify: true };
  const list = hitsFor(p.id).slice(-500).reverse();
  return `<div class="log-watch-rules spec-row wrap">
      <label class="hint"><input type="checkbox" id="lw-levels" ${w.levels !== false ? 'checked' : ''}/> Flag ERROR / FATAL lines</label>
      <label class="hint" for="lw-patterns">and lines with</label><input type="text" id="lw-patterns" value="${esc(w.patterns || '')}" placeholder="Timeout, OutOfMemory, /payment .* failed/i" spellcheck="false" class="grow mono"/>
      <label class="hint"><input type="checkbox" id="lw-notify" ${w.notify !== false ? 'checked' : ''}/> Notify</label>
      <button class="btn-ghost small" data-action="log-watch-clear" ${list.length ? '' : 'disabled'}>Clear</button></div>
    <p class="hint">Checked on every line of the project's tasks and log sources while they run. A response shows the lines flagged while it ran (Logs tab).</p>
    <div class="log-flagged">${list.length ? list.map((h) => `<div class="log-flag" data-action="log-hit-open" data-source="${esc(h.sourceId)}" title="Show ${esc(h.sourceName)}">
      <span class="hint">${new Date(h.at).toLocaleTimeString()}</span><b>${esc(h.sourceName)}</b><span class="log-flag-rule">${esc(h.rule)}</span><span class="mono log-flag-text">${esc(h.text)}</span></div>`).join('')
      : '<p class="hint pad-8">Nothing flagged yet.</p>'}</div>`;
}

export function tasksPageHtml() {
  const p = currentProject();
  if (!p) return '<p class="hint">Select a project first.</p>';
  const all = [...p.tasks.map((t) => ({ kind: 'task', item: t })), ...p.logSources.map((s) => ({ kind: 'source', item: s }))];
  const sel = all.find((x) => x.item.id === S.tasks.id) || all[0];
  const row = ({ kind, item }) => {
    const state = kind === 'task' ? taskInfo(item.id).state : item.running ? 'ready' : 'stopped';
    const port = kind === 'task' && taskInfo(item.id).port ? `<span class="hint">:${taskInfo(item.id).port}</span>` : '';
    return `<div class="sidebar-item${sel?.item === item ? ' active' : ''}" data-action="task-select" data-id="${esc(item.id)}">
      <span class="item-name">${kind === 'source' ? `<span class="hint">${esc({ ssh: 'SSH', kubernetes: 'K8s', docker: 'Docker', file: 'File', command: 'Cmd' }[item.type] || '')}</span> ` : ''}${esc(item.name)}</span>${port}${stateChip(state)}</div>`;
  };
  const controls = !sel ? '' : sel.kind === 'task'
    ? (() => { const st = taskInfo(sel.item.id).state; const on = st === 'starting' || st === 'ready' || st === 'stopping';
        return `<button class="btn-primary small" data-action="task-start" ${on ? 'disabled' : ''}>${icon('play')} Start</button>
          <button class="btn-ghost small" data-action="task-stop" ${on ? '' : 'disabled'}>${icon('stop')} Stop</button>
          <button class="btn-ghost small" data-action="task-restart" ${sel.item.command ? '' : 'disabled'}>↻ Restart</button>
          ${taskInfo(sel.item.id).port && st === 'ready' ? `<button class="btn-ghost small" data-action="open-actuator" data-port="${taskInfo(sel.item.id).port}" title="Health, environment, mappings and log levels of this running app">Actuator</button>` : ''}`; })()
    : `<button class="btn-primary small" data-action="ls-start" ${sel.item.running ? 'disabled' : ''}>▶ Follow</button>
       <button class="btn-ghost small" data-action="ls-stop" ${sel.item.running ? '' : 'disabled'}>${icon('stop')} Stop</button>`;
  const searchView = S.tasks.view === 'search';
  const flaggedView = S.tasks.view === 'flagged';
  const flaggedCount = hitsFor(p.id).length;
  const viewTabs = sel ? `<div class="tabs log-view-tabs"><button class="tab${searchView || flaggedView ? '' : ' active'}" data-action="log-view" data-view="live">Live</button>
    <button class="tab${searchView ? ' active' : ''}" data-action="log-view" data-view="search">${icon('search')} Search logs</button>
    <button class="tab${flaggedView ? ' active' : ''}" data-action="log-view" data-view="flagged">Flagged${flaggedCount ? ` <span class="badge-err">${flaggedCount}</span>` : ''}</button></div>` : '';
  const logs = !sel ? '' : flaggedView ? flaggedHtml(p) : searchView
    ? `${searchForm(p, sel)}<div id="log-search-results">${searchResultsHtml(S.tasks.search.results, S.tasks.search)}</div>`
    : `<div class="log-toolbar">
      <input type="text" id="log-filter" placeholder="Filter lines…" value="${esc(S.tasks.filter)}" spellcheck="false"/>
      <select id="log-level">${['all', 'INFO', 'WARN', 'ERROR'].map((l) => `<option value="${l}" ${S.tasks.level === l ? 'selected' : ''}>${l === 'all' ? 'All levels' : l + '+'}</option>`).join('')}</select>
      <label class="hint"><input type="checkbox" id="log-follow" ${S.tasks.follow ? 'checked' : ''}/> Follow</label>
      <button class="btn-ghost small" data-action="log-clear">Clear</button></div>
    <div id="log-view" class="log-view">${logEntriesHtml(logLines(sel.item.id), { filter: S.tasks.filter, minLevel: S.tasks.level })}</div>`;
  const popOut = sel ? `<button class="btn-ghost small" data-action="logs-pop-out" data-id="${esc(sel.item.id)}" title="Open these logs in their own window (one per task / source)">⧉ Pop out</button>` : '';
  return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button><h3>Tasks &amp; logs: ${esc(p.name)}</h3></div>
    <div class="tasks-layout">
      <div class="tasks-list">${all.map(row).join('') || '<p class="hint" style="padding:6px">No tasks yet.</p>'}
        <div style="display:flex;gap:4px;margin:6px 4px;flex-wrap:wrap"><button class="btn-ghost small" data-action="task-new">+ Task</button><button class="btn-ghost small" data-action="ls-new">+ Log source</button></div>
        <div class="hint" style="padding:4px 6px">Requests are tagged with <code>X-Request-Id</code> and <code>traceparent</code>${p.correlation ? '' : ' <b>(off for this project)</b>'}; a response's <b>Logs</b> tab shows the lines carrying them.</div></div>
      <div class="tasks-main">${sel ? `<div class="spec-row"><b>${esc(sel.item.name)}</b> ${controls}<span class="grow"></span>${popOut}</div>
        ${sel.kind === 'task' ? taskEditor(sel.item) : sourceEditor(sel.item)}${viewTabs}${logs}` : '<p class="hint">Add a task to start a local service (e.g. a Spring Boot app), or a log source to follow and search logs on a server (SSH), in Kubernetes or Docker, or in a file.</p>'}</div></div>`;
}

// Append-only update of the open log view (keeps scroll position unless following).
export function refreshLogView() {
  const view = $('log-view'); if (!view) return;
  const p = currentProject(); if (!p) return;
  const id = S.tasks.id || p.tasks[0]?.id || p.logSources[0]?.id;
  view.innerHTML = logEntriesHtml(logLines(id), { filter: S.tasks.filter, minLevel: S.tasks.level });
  if (S.tasks.follow) view.scrollTop = view.scrollHeight;
}
