// Compare mode: two requests side by side, with a diff of their responses.
import { S, findReq } from '../store.js';
import { recordHistory } from '../history.js';
import { send } from '../http.js';
import { renderCompare, renderSidebar } from '../views/index.js';
import { setPage, attachValidation } from './core.js';

// Same request in two environments (Compare → "Same request, two environments").
async function abSend() {
  const ab = S.compare.ab, loc = ab.reqId && findReq(ab.reqId); if (!loc) return;
  const envFor = (id) => (id ? loc.p.envs.find((e) => e.id === id) : undefined);
  ab.results = [{ loading: true }, { loading: true }].map(() => null); renderCompare();
  const [a, b] = await Promise.all([ab.envA, ab.envB].map(async (envId) => attachValidation(loc, await send(loc, undefined, { env: envFor(envId) }))));
  // No environment picked: send() used the active one.
  recordHistory(loc, a, { envId: ab.envA || loc.p.activeEnv }); recordHistory(loc, b, { envId: ab.envB || loc.p.activeEnv });
  ab.results = [a, b]; renderCompare(); renderSidebar();
}

export const compareActions = {
  'compare-mode'(d) { S.compare.mode = d.mode; renderCompare(); },
  'ab-send'() { abSend(); },
  'toggle-compare'() { setPage(S.page === 'compare' ? 'request' : 'compare'); },
  async 'slot-send'(d) {
    const si = +d.slot, id = S.compare.slots[si], loc = id && findReq(id); if (!loc) return;
    const res = await attachValidation(loc, await send(loc));
    recordHistory(loc, res);
    if (S.compare.slots[si] === id) S.compare.results[si] = res; // ignore if a different request was picked meanwhile
    renderCompare(); renderSidebar(); // the History panel lists this send too
  },
};

// Pickers in "two environments" mode ('change' on #ab-req / #ab-env-a / #ab-env-b).
export function onCompareChange(el) {
  const ab = S.compare.ab;
  if (el.id === 'ab-req') { ab.reqId = el.value || null; ab.results = [null, null]; }
  else if (el.id === 'ab-env-a') ab.envA = el.value || null;
  else if (el.id === 'ab-env-b') ab.envB = el.value || null;
  else return false;
  renderCompare();
  return true;
}

// The request pickers ('change' on #slot-sel-N).
export function pickSlot(si, reqId) {
  S.compare.slots[si] = reqId || null; S.compare.results[si] = null; renderCompare();
}
