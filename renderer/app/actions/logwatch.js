// Log watch wiring: checks every incoming log line against its project's watch rules (logwatch.js),
// shows a status bar count and notifications, and backs the Tasks page's Flagged tab.
import { notify } from '../../shared/notify.js';
import { DB, S, saveDB, currentProject } from '../store.js';
import { watchMatcher, addHits, unseenCount, markSeen, clearHits } from '../logwatch.js';
import { renderPage, renderStatusBar, registerStatusItem } from '../views/index.js';
import { setPage } from './core.js';

const DEFAULT_WATCH = { levels: true, patterns: '', notify: true };
export const watchOf = (p) => (p.logWatch ||= { ...DEFAULT_WATCH });

function ownerOf(id) {
  for (const p of DB.projects) {
    const item = p.tasks.find((t) => t.id === id) || p.logSources.find((s) => s.id === id);
    if (item) return { p, item };
  }
  return null;
}

const lastNotified = new Map(); // source id → time (at most one notification per source every 10 s)
let renderTimer = 0;

export function initLogWatch() {
  window.electronAPI.onLogLines(({ id, lines }) => {
    const o = ownerOf(id); if (!o) return;
    const watch = watchOf(o.p), test = watchMatcher(watch);
    const found = [];
    for (const l of lines) { const rule = test(l); if (rule) found.push({ key: `${id}:${l.n}`, sourceId: id, sourceName: o.item.name, projectId: o.p.id, at: l.at, n: l.n, text: l.text, rule }); }
    if (!found.length) return;
    addHits(found);
    renderStatusBar();
    if (watch.notify && Date.now() - (lastNotified.get(id) || 0) > 10000 && !(S.page === 'tasks' && S.tasks.view === 'flagged')) {
      lastNotified.set(id, Date.now());
      notify(`${o.item.name}: ${found.length} flagged log line${found.length === 1 ? '' : 's'} — ${found[0].text.slice(0, 120)}`, 'error', 6000, { label: 'Show', run: () => logWatchActions['open-log-watch']() });
    }
    if (S.page === 'tasks' && S.tasks.view === 'flagged' && !renderTimer) renderTimer = setTimeout(() => { renderTimer = 0; markSeen(); renderPage(); }, 300);
  });
  registerStatusItem(() => {
    const p = currentProject(); const n = p ? unseenCount(p.id) : 0;
    return n ? `<button class="status-item status-flagged" data-action="open-log-watch" title="Flagged log lines (log watch)">⚠ ${n} flagged</button>` : '';
  });
}

export const logWatchActions = {
  'open-log-watch'() { S.tasks.view = 'flagged'; markSeen(); setPage('tasks'); renderStatusBar(); },
  'log-watch-clear'() { clearHits(); renderPage(); renderStatusBar(); },
  'log-hit-open'(d) { Object.assign(S.tasks, { id: d.source, view: 'live', filter: '' }); renderPage(); },
};

export function onLogWatchInput(el) {
  const p = currentProject(); if (!p) return false;
  if (el.id === 'lw-patterns') { watchOf(p).patterns = el.value; saveDB(); return true; }
  if (el.id === 'lw-levels') { watchOf(p).levels = el.checked; saveDB(); return true; }
  if (el.id === 'lw-notify') { watchOf(p).notify = el.checked; saveDB(); return true; }
  return false;
}
