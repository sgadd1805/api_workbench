// Load test page.
import { notify } from '../../shared/notify.js';
import { S, findReq, effectiveAuth, uid } from '../store.js';
import { buildRequest } from '../http.js';
import { getToken } from '../tokens.js';
import { renderPage } from '../views/index.js';
import { setPage } from './core.js';

const L = () => S.load;
let wired = false;

export const loadActions = {
  'open-load'() {
    if (S.req) { if (L().reqId !== S.req.id) Object.assign(L(), { reqId: S.req.id, stats: null }); }
    if (!wired) {
      wired = true;
      window.electronAPI.onLoadProgress((p) => {
        if (p.id !== L().runId) return;
        Object.assign(L(), { done: p.done, target: p.target, stats: p.stats, running: !p.final });
        if (p.final) notify(`Load test ${p.stopped ? 'stopped' : 'finished'}: ${p.stats.count} requests, p95 ${p.stats.p95} ms, ${p.stats.failed} failed`, p.stats.failed ? 'error' : 'info', 6000);
        if (S.page === 'load') renderPage();
      });
    }
    setPage('load');
  },
  async 'load-start'() {
    const l = L(), loc = l.reqId && findReq(l.reqId); if (!loc) return;
    const auth = effectiveAuth(loc);
    let token;
    try { if (auth.type === 'token') token = (await getToken(auth.sourceId, loc.p)).token; } catch (err) { return notify(err.message, 'error'); }
    const { missingVars, ...request } = buildRequest(loc, { token });
    if (missingVars.length) notify(`{{${missingVars.join('}}, {{')}}} not defined — sent as written`, 'error');
    Object.assign(l, { runId: uid(), running: true, done: 0, stats: null });
    renderPage();
    window.electronAPI.loadRun({ id: l.runId, request, total: l.total, concurrency: l.concurrency, durationSec: l.durationSec });
  },
  'load-stop'() { window.electronAPI.loadStop(L().runId); },
};

export function onLoadInput(el) {
  const l = L(), n = (v, min, max) => Math.min(max, Math.max(min, parseInt(v, 10) || 0));
  if (el.id === 'load-total') { l.total = n(el.value, 1, 1_000_000); return true; }
  if (el.id === 'load-concurrency') { l.concurrency = n(el.value, 1, 500); return true; }
  if (el.id === 'load-duration') { l.durationSec = n(el.value, 0, 3600); document.getElementById('load-total').disabled = !!l.durationSec; return true; }
  return false;
}
