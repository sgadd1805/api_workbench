// Key/value row lists (views/kv.js). data-list names which list a row belongs to.
// 'params' is special: its rows are the URL's query string, so edits rewrite S.req.url.
import { recordVar } from '../varlog.js';
import { $ } from '../../shared/html.js';
import { S, saveDB, setRequestUrl, currentProject, activeTab } from '../store.js';
import { queryRows, withQuery } from '../query.js';
import { selectedEnv } from '../views/envs.js';
import { selectedTokenSource } from '../views/tokens.js';
import { forgetTokens } from '../tokens.js';
import { renderSidebar, renderTabBar, renderRequestPanel, renderPage, renderStatusBar } from '../views/index.js';
import { refreshUrlField } from '../editor.js';

const LISTS = {
  headers: () => S.req?.headers,
  form: () => S.req?.body.form,
  chain: () => S.req?.chain,
  vars: () => selectedEnv(currentProject())?.vars,
  'login-urls': () => selectedEnv(currentProject())?.loginUrls,
  'ts-headers': () => selectedTokenSource()?.headers,
  'ts-form': () => selectedTokenSource()?.body.form,
  'task-env': () => { const p = currentProject(); return p?.tasks.find((t) => t.id === (S.tasks.id || p.tasks[0]?.id))?.env; },
};
const PAGE_LISTS = new Set(['vars', 'login-urls', 'ts-headers', 'ts-form', 'task-env']);
const rerenderFor = (list) => (PAGE_LISTS.has(list) ? renderPage() : renderRequestPanel());

function setParams(rows) {
  setRequestUrl(S.req, withQuery(S.req.url, rows));
  const urlInput = $('url-input'); if (urlInput) { urlInput.value = S.req.url; refreshUrlField(urlInput); }
  renderSidebar(); renderTabBar();
}

export const rowActions = {
  'row-secret'(d) {
    const row = LISTS[d.list]?.()?.[+d.idx]; if (!row) return;
    row.secret = !row.secret; saveDB(); rerenderFor(d.list);
  },
  'add-kv'(d) {
    if (d.list === 'params') { activeTab().pendingParam = true; renderRequestPanel(); return; }
    LISTS[d.list]?.()?.push({ k: '', v: '', on: true });
    saveDB(); rerenderFor(d.list);
  },
  'del-kv'(d) {
    if (d.list === 'params') {
      const rows = queryRows(S.req.url);
      if (+d.idx >= rows.length) activeTab().pendingParam = false; else { rows.splice(+d.idx, 1); setParams(rows); }
      saveDB(); renderRequestPanel(); return;
    }
    LISTS[d.list]?.()?.splice(+d.idx, 1);
    saveDB(); rerenderFor(d.list);
  },
};

// An 'input' event in a row (no re-render, so the field keeps focus). Returns false if el isn't a row field.
export function onRowInput(el) {
  const { list, k } = el.dataset, idx = +el.dataset.idx;
  if (!list || !k) return false;
  if (list === 'params') {
    const rows = queryRows(S.req.url);
    if (idx >= rows.length) { rows.push({ k: '', v: '' }); activeTab().pendingParam = false; }
    rows[idx][k] = el.value;
    setParams(rows);
  } else {
    const row = LISTS[list]?.()?.[idx]; if (!row) return true;
    if (list === 'vars' && k === 'v') { const p = currentProject(), env = selectedEnv(p); recordVar({ p, env, name: row.k, before: row.v, value: el.value, secret: !!row.secret, source: 'edited on the Environments page', kind: 'edit' }); }
    row[k] = el.type === 'checkbox' ? el.checked : el.value;
    if (list.startsWith('ts-')) forgetTokens(selectedTokenSource()?.id);
    if (list === 'login-urls') renderStatusBar(); // updates the Session toolbar's login picker
  }
  saveDB();
  return true;
}
