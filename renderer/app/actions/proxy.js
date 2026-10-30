// Intercepting proxy page (main/proxy.js does the work). Captured exchanges are kept in memory
// (newest first) and optionally added to History; paused requests wait for Forward / Drop.
import { copyText } from '../../shared/html.js';
import { notify } from '../../shared/notify.js';
import { DB, S, saveDB, currentProject, addRequest, newReq } from '../store.js';
import { recordExchange } from '../history.js';
import { recordedHosts, recordedRoutes } from '../recorded.js';
import { openModal } from '../modal.js';
import { toCurl } from '../curl.js';
import { renderPage, renderSidebar, renderStatusBar } from '../views/index.js';
import { trafficHtml, detailHtml, pausedCardHtml, pausedTitle } from '../views/proxy.js';
import { setPage, openReq } from './core.js';
import { icon } from '../../shared/icons.js';

const api = window.electronAPI;
const P = () => S.proxy;
const MAX_KEPT = 1000;
const SETTINGS = ['port', 'decryptHttps', 'allowLan', 'insecureUpstream', 'toHistory', 'breakpoints'];

const saveSettings = () => { DB.settings.proxy = Object.fromEntries(SETTINGS.map((k) => [k, P()[k]])); saveDB(); };
const rules = () => P().breakpoints.split('\n').map((l) => l.trim()).filter(Boolean);
const $id = (id) => document.getElementById(id);

// Partial updates, so typing in the page's inputs isn't interrupted by arriving traffic.
let trafficTimer = 0;
function refreshTraffic() {
  if (trafficTimer) return;
  trafficTimer = setTimeout(() => {
    trafficTimer = 0;
    if (S.page !== 'proxy') return;
    const t = $id('proxy-traffic'); if (t) t.innerHTML = trafficHtml(P());
    const c = $id('proxy-count'); if (c) c.textContent = P().exchanges.length;
  }, 150);
}
function refreshPaused() {
  renderStatusBar();
  const box = $id('proxy-paused'); if (!box || S.page !== 'proxy') return;
  const ids = new Set(P().paused.map((p) => p.id));
  for (const card of box.querySelectorAll('.paused-card')) if (!ids.has(card.dataset.id)) card.remove();
  for (const p of P().paused) if (!box.querySelector(`.paused-card[data-id="${CSS.escape(p.id)}"]`)) box.insertAdjacentHTML('beforeend', pausedCardHtml(p));
  $id('proxy-paused-title').innerHTML = pausedTitle(P().paused.length);
}
const refreshDetail = () => { const d = $id('proxy-detail'); if (d) d.innerHTML = detailHtml(P().exchanges.find((x) => x.id === P().selected)); };

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  Object.assign(P(), DB.settings.proxy || {});
  api.onProxyExchange((x) => {
    P().exchanges.unshift(x);
    if (P().exchanges.length > MAX_KEPT) P().exchanges.length = MAX_KEPT;
    if (P().toHistory && !x.tunnel) { recordExchange(x); if (S.sidebarMode === 'history') renderSidebar(); }
    refreshTraffic();
  });
  api.onProxyPaused((p) => {
    P().paused.push(p);
    notify(`Paused at a breakpoint: ${p.method} ${p.url}`, 'info', 6000, S.page === 'proxy' ? null : { label: 'Show', run: () => proxyActions['open-proxy']() });
    refreshPaused();
  });
}

// The edited request from a paused card.
function editedRequest(id) {
  const card = document.querySelector(`.paused-card[data-id="${CSS.escape(id)}"]`);
  const p = P().paused.find((x) => x.id === id);
  if (!card || !p) return null;
  const headers = {};
  for (const line of card.querySelector('.pz-headers').value.split('\n')) {
    const at = line.indexOf(':'); if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const bodyEl = document.getElementById(`pz-body-${id}`);
  return { method: card.querySelector('.pz-method').value, url: card.querySelector('.pz-url').value.trim(), headers, body: bodyEl ? bodyEl.value : null };
}

async function resume(id, decision) {
  await api.proxyResume(id, decision);
  P().paused = P().paused.filter((p) => p.id !== id);
  refreshPaused();
}

const selected = () => P().exchanges.find((x) => x.id === P().selected);

let mockHitsWired = false;
function wireMockHits() {
  if (mockHitsWired) return;
  mockHitsWired = true;
  api.onMockHit((h) => {
    const m = P().mocks[h.id]; if (!m) return;
    m.hits++;
    const el = $id(`rec-hits-${h.id}`); if (el) el.textContent = `${m.hits} request${m.hits === 1 ? '' : 's'} served`;
  });
}

export const proxyActions = {
  async 'open-proxy'() {
    wire();
    setPage('proxy');
    if (!P().ca) { const ca = await api.proxyCa({ peek: true }); if (ca.ok && !ca.none) { P().ca = ca; renderPage(); } }
  },
  async 'proxy-start'() {
    wire();
    const port = parseInt($id('proxy-port')?.value, 10) || P().port || 8899;
    Object.assign(P(), { port });
    const res = await api.proxyStart({ port, allowLan: P().allowLan, decryptHttps: P().decryptHttps, insecureUpstream: P().insecureUpstream, breakpoints: rules() });
    if (!res.ok) return notify(res.error, 'error', 8000);
    Object.assign(P(), { running: true, port: res.port, lan: res.lan || [] });
    if (P().decryptHttps) { const ca = await api.proxyCa(); if (ca.ok) P().ca = ca; }
    saveSettings(); renderPage(); renderStatusBar();
  },
  async 'proxy-stop'() {
    await api.proxyStop();
    Object.assign(P(), { running: false, paused: [] });
    renderPage(); renderStatusBar();
  },
  'proxy-select'(d) { P().selected = P().selected === d.id ? null : d.id; refreshTraffic(); refreshDetail(); },
  'proxy-mock-new'() {
    const hosts = recordedHosts(P().exchanges);
    if (!hosts.length) return notify('No recorded responses yet (HTTPS needs "Decrypt HTTPS" to be recorded)', 'error', 7000);
    openModal({ title: 'Mock a host from recorded traffic', ok: 'Start mock', fields: [
      { key: 'host', label: 'Host', type: 'select', options: hosts.map((h) => ({ value: h.host, label: `${h.host} (${h.count} exchanges)` })), value: hosts[0].host },
      { key: 'generalize', label: 'Paths', type: 'select', value: 'yes', options: [{ value: 'yes', label: 'Treat ids in paths as parameters (/pets/7 → /pets/{id})' }, { value: 'no', label: 'Exact recorded paths only' }] },
      { key: 'port', label: 'Port (empty = any free port)', value: '' }],
    onOk: async (v) => {
      wireMockHits();
      const routes = recordedRoutes(P().exchanges, { host: v.host, generalize: v.generalize === 'yes' });
      const id = `rec:${v.host}`;
      const res = await api.mockStart({ id, routes, port: parseInt(v.port, 10) || 0 });
      if (!res.ok) return notify(res.error, 'error');
      P().mocks[id] = { host: v.host, url: res.url, port: res.port, routes, hits: 0 };
      notify(`Mock of ${v.host} on ${res.url} (${routes.length} routes)`);
      renderPage();
    } });
  },
  async 'proxy-mock-stop'(d) { await api.mockStop(d.id); delete P().mocks[d.id]; renderPage(); },
  'proxy-clear'() { Object.assign(P(), { exchanges: [], selected: null }); refreshTraffic(); refreshDetail(); },
  'proxy-forward'(d) { resume(d.id, d.original ? { action: 'forward' } : { action: 'forward', request: editedRequest(d.id) }); },
  'proxy-drop'(d) { resume(d.id, { action: 'drop' }); },
  'proxy-save'() {
    const x = selected(), p = currentProject(); if (!x) return;
    if (!p) return notify('Select a project first', 'error');
    const body = x.request?.binary ? '' : x.request?.body || '';
    const type = Object.entries(x.requestHeaders || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
    const skip = /^(host|content-length|accept-encoding|connection)$/i;
    let name = x.url; try { const u = new URL(x.url); name = `${x.method} ${u.pathname}`; } catch { /* raw */ }
    const r = addRequest(p, null, newReq({ name, method: x.method, url: x.url,
      headers: Object.entries(x.requestHeaders || {}).filter(([k]) => !skip.test(k)).map(([k, v]) => ({ k, v, on: true })),
      body: body ? { type: /json/i.test(type) ? 'json' : 'raw', text: body, form: [] } : { type: 'none', text: '', form: [] } }));
    S.projectOpen[p.id] = true; saveDB(); openReq(r.id);
    notify(`Saved to ${p.name}`);
  },
  'proxy-curl'(_d, el) {
    const x = selected(); if (!x) return;
    copyText(toCurl({ method: x.method, url: x.url, headers: Object.fromEntries(Object.entries(x.requestHeaders || {}).filter(([k]) => !/^(host|content-length)$/i.test(k))), body: x.request?.binary ? '' : x.request?.body }));
    if (el) { const t = el.textContent; el.textContent = 'Copied'; setTimeout(() => { el.textContent = t; }, 1000); }
  },
  async 'proxy-ca-export'() {
    const ca = await api.proxyCa(); if (!ca.ok) return notify(ca.error, 'error');
    P().ca = ca;
    const res = await api.saveTextFile('api-workbench-proxy-ca.crt', ca.certPem);
    if (res.ok) notify('Saved ' + res.filePath); else if (!res.canceled) notify(res.error, 'error');
    renderPage();
  },
  async 'proxy-ca-open'() { const res = await api.proxyCaOpen(); if (!res.ok) notify(res.error, 'error'); },
  async 'proxy-ca-regenerate'() {
    const ca = await api.proxyCa({ regenerate: true }); if (!ca.ok) return notify(ca.error, 'error');
    P().ca = ca;
    notify(P().running ? 'New CA created. Restart the proxy, and trust the new certificate where you trusted the old one.' : 'New CA created. Trust the new certificate where you trusted the old one.', 'info', 8000);
    renderPage();
  },
};

export function onProxyInput(el) {
  if (el.id === 'proxy-filter') { P().filter = el.value; refreshTraffic(); return true; }
  if (el.id === 'proxy-breakpoints') { P().breakpoints = el.value; saveSettings(); if (P().running) api.proxyUpdate({ breakpoints: rules() }); return true; }
  return el.id === 'proxy-port' || el.classList.contains('pz-url') || el.classList.contains('pz-headers') || el.id?.startsWith('pz-body-');
}
export function onProxyChange(el) {
  if (el.classList.contains('rec-ov')) {
    const m = P().mocks[el.dataset.mock], r = m?.routes[+el.dataset.route]; if (!r) return true;
    if (el.value === r.defaultCode) delete r.override; else r.override = el.value;
    api.mockUpdate({ id: el.dataset.mock, routes: m.routes });
    return true;
  }
  const map = { 'proxy-decrypt': 'decryptHttps', 'proxy-lan': 'allowLan', 'proxy-insecure': 'insecureUpstream', 'proxy-history': 'toHistory' };
  if (map[el.id]) {
    P()[map[el.id]] = el.checked; saveSettings();
    if (el.id === 'proxy-lan') renderPage(); // shows / hides the warning
    if (el.id === 'proxy-insecure' && P().running) api.proxyUpdate({ insecureUpstream: el.checked });
    return true;
  }
  return el.classList.contains('pz-method');
}

// One proxy option from outside the Proxy page (the ⌘K palette). allowLan and decryptHttps apply at the next start.
export function setProxyOption(key, value) {
  wire();
  P()[key] = value; saveSettings();
  if (key === 'allowLan' && value) notify('The proxy will be reachable from your network without a password when it starts: use it only on a network you trust', 'error', 9000);
  if (key === 'insecureUpstream' && P().running) api.proxyUpdate({ insecureUpstream: value });
  if (S.page === 'proxy') renderPage();
}
export const proxyOptions = () => { wire(); return P(); };

// Status bar: running proxy and paused requests.
export function proxyStatusItem() {
  if (!P().running) return '';
  const n = P().paused.length;
  const lan = P().lan?.length > 0;
  return `<button class="status-item${n || lan ? ' warn-text' : ''}" data-action="open-proxy" title="Intercepting proxy${lan ? ': reachable from your network, without a password' : ''}">⇄ proxy :${P().port}${lan ? ' · open to network' : ''}${n ? ` · ${icon('pause')} ${n}` : ''}</button>`;
}
