// Token Sources page.
import { notify } from '../../shared/notify.js';
import { DB, S, saveDB, currentProject, uid, findReq, effectiveAuth } from '../store.js';
import { buildRequest } from '../http.js';
import { newTokenSource, tokenSourceFromFile, getToken, forgetTokens, bearerOf } from '../tokens.js';
import { selectedTokenSource } from '../views/tokens.js';
import { renderPage, renderRequestPanel } from '../views/index.js';
import { openModal } from '../modal.js';
import { setPage } from './core.js';
import { sendToTool } from './layout.js';

const changed = () => { saveDB(); renderPage(); };

export function openTokenSources(id) { if (id) S.tokens.id = id; S.tokens.test = null; setPage('tokens'); }

export const tokenActions = {
  'open-tokens'(d) { openTokenSources(d?.id); },
  'ts-open'(d) { S.tokens.id = d.id; S.tokens.test = null; renderPage(); },
  'ts-new'() { const t = newTokenSource(); DB.tokenSources.push(t); S.tokens.id = t.id; S.tokens.test = null; changed(); document.getElementById('ts-name')?.select(); },
  'ts-duplicate'() {
    const src = selectedTokenSource(); if (!src) return;
    const copy = { ...structuredClone(src), id: uid(), name: src.name + ' copy' };
    DB.tokenSources.push(copy); S.tokens.id = copy.id; changed();
  },
  'ts-delete'() {
    const src = selectedTokenSource(); if (!src) return;
    openModal({ title: `Delete "${src.name}"?`, ok: 'Delete', fields: [], hint: 'Requests that use it will report that their token source is missing until you pick another.',
      onOk: () => { DB.tokenSources = DB.tokenSources.filter((t) => t !== src); forgetTokens(src.id); S.tokens.id = null; changed(); } });
  },
  async 'ts-import'() {
    const file = await window.electronAPI.openTextFile();
    if (!file.ok) { if (!file.canceled) notify(file.error, 'error'); return; }
    try {
      const t = tokenSourceFromFile(file.content);
      DB.tokenSources.push(t); S.tokens.id = t.id; S.tokens.test = null; changed();
      notify(`Imported token source "${t.name}"`);
    } catch (err) { notify('Import failed: ' + err.message, 'error', 8000); }
  },
  async 'ts-test'() {
    const src = selectedTokenSource(); if (!src) return;
    S.tokens.test = null; renderPage();
    try { S.tokens.test = { id: src.id, ...(await getToken(src.id, currentProject(), { force: true })) }; }
    catch (err) { S.tokens.test = { id: src.id, error: err.message }; }
    renderPage();
  },
  'ts-forget'() { const src = selectedTokenSource(); if (src) { forgetTokens(src.id); renderPage(); } },
  // Token inspector line (views/tokenchip.js)
  'token-inspect'() { const loc = S.req && findReq(S.req.id); const t = loc && bearerOf(buildRequest(loc).headers); if (t) sendToTool('jwt', t); },
  async 'token-refresh'() {
    const loc = S.req && findReq(S.req.id); if (!loc) return;
    const auth = effectiveAuth(loc);
    if (auth.type !== 'token') return import('./io.js').then((m) => m.useLoginSession());
    try { await getToken(auth.sourceId, loc.p, { force: true }); notify('Fetched a fresh token'); } catch (err) { notify(err.message, 'error', 8000); }
    renderRequestPanel();
  },
  'ts-to-jwt'() { if (S.tokens.test?.token) sendToTool('jwt', S.tokens.test.token); },
};

// Editor fields ('input' / 'change').
export function onTokenSourceInput(el) {
  const src = selectedTokenSource(); if (!src) return false;
  const map = { 'ts-name': 'name', 'ts-url': 'url', 'ts-token-path': 'tokenPath' };
  if (map[el.id]) { src[map[el.id]] = el.value; forgetTokens(src.id); saveDB(); return true; }
  if (el.id === 'ts-body') { src.body.text = el.value; forgetTokens(src.id); saveDB(); return true; }
  return false;
}
export function onTokenSourceChange(el) {
  const src = selectedTokenSource(); if (!src) return false;
  if (el.id === 'ts-method') { src.method = el.value; forgetTokens(src.id); changed(); return true; }
  if (el.name === 'ts_body_type') { src.body.type = el.value; forgetTokens(src.id); changed(); return true; }
  if (el.id === 'ts-name') { renderPage(); return true; } // refresh the list label once editing is done
  return false;
}
