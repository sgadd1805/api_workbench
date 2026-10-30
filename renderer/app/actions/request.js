// The request editor: tabs, send/cancel, cURL copy, and the request's own menu (rename/move/feature/delete).
import { copyText, flashDone } from '../../shared/html.js';
import { prettyJson, isJson } from '../../shared/json.js';
import { notify } from '../../shared/notify.js';
import { S, saveDB, findReq, activeTab, duplicateRequest } from '../store.js';
import { buildRequest } from '../http.js';
import { toCurl } from '../curl.js';
import { SNIPPETS, snippet } from '../snippets.js';
import { renderAll, renderRequestPanel } from '../views/index.js';
import { openMenu } from '../views/menu.js';
import { openReq, sendCurrent, cancelCurrent } from './core.js';
import { rowMenu } from './sidebar.js';

export const requestActions = {
  tab(d) { activeTab().editorTab = d.tab; renderRequestPanel(); },
  send() { sendCurrent(); },
  'cancel-send'() { cancelCurrent(); },
  'copy-curl'(_d, el) {
    const loc = findReq(S.req.id); if (!loc) return;
    copyText(toCurl(buildRequest(loc))); flashDone(el);
  },
  // "Code ▾": the request (variables resolved) as cURL, fetch, axios, Python, Java or C#, copied.
  'copy-code'(_d, el) {
    const loc = findReq(S.req.id); if (!loc) return;
    openMenu([{ head: 'Copy as code' }, ...SNIPPETS.map(([id, label]) => ({ label, run: () => { copyText(snippet(id, buildRequest(loc))); notify(`Copied as ${label}`); } }))], el);
  },
  'format-json-body'() {
    if (!isJson(S.req.body.text)) return notify('The body isn\'t valid JSON yet', 'error');
    S.req.body.text = prettyJson(S.req.body.text); saveDB(); renderRequestPanel();
  },
  'duplicate-req'() {
    const copy = duplicateRequest(S.req.id); if (!copy) return;
    saveDB(); openReq(copy.id); notify('Duplicated');
  },
  'request-menu'(_d, el) { if (S.req) openMenu(rowMenu('request', S.req.id), el); },
};
