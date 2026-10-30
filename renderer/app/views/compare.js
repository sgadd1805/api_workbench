// Compare mode: two requests side by side, or one request in two environments ("A/B"), with diffs.
import { $, esc } from '../../shared/html.js';
import { prettyJson } from '../../shared/json.js';
import { lineDiff, diffHtml } from '../../shared/diff.js';
import { DB, S, findReq, allRequests, currentProject } from '../store.js';
import { responseHtml } from './response.js';

const bodyDiff = (a, b) => `<div class="compare-col" style="flex:1.2"><div class="url-bar"><b>Diff (A → B)</b></div><div class="response-panel">
    ${a.status !== b.status ? `<p class="warn-text">Status differs: ${a.status} → ${b.status}</p>` : ''}
    <pre class="resp-body">${diffHtml(lineDiff(prettyJson(a.body), prettyJson(b.body)))}</pre></div></div>`;

// Headers and timing side by side for the two environments.
function envSummary(a, b) {
  const keys = [...new Set([...Object.keys(a.headers || {}), ...Object.keys(b.headers || {})])].filter((k) => !/^(date|x-request-id|traceparent)$/i.test(k)).sort();
  const changed = keys.filter((k) => a.headers?.[k] !== b.headers?.[k]);
  const t = (r, k) => (r.timing ? `${r.timing[k]} ms` : '—');
  return `<table class="run-table ab-table"><tr><th></th><th>A</th><th>B</th></tr>
    <tr><td>Status</td><td>${a.status ?? esc(a.error || '')}</td><td>${b.status ?? esc(b.error || '')}</td></tr>
    <tr><td>Total time</td><td>${a.time ?? '—'} ms</td><td>${b.time ?? '—'} ms</td></tr>
    <tr><td>Waiting (TTFB)</td><td>${t(a, 'wait')}</td><td>${t(b, 'wait')}</td></tr>
    <tr><td>Body size</td><td>${(a.body || '').length} B</td><td>${(b.body || '').length} B</td></tr>
    ${changed.map((k) => `<tr class="ab-diff"><td><code>${esc(k)}</code></td><td>${esc(a.headers?.[k] ?? '—')}</td><td>${esc(b.headers?.[k] ?? '—')}</td></tr>`).join('')}
    ${changed.length ? '' : '<tr><td colspan="3" class="hint">Same headers (ignoring date / request id)</td></tr>'}</table>`;
}

function envsMode() {
  const p = currentProject();
  const { ab, resTab = 'body' } = S.compare;
  const reqs = p ? allRequests(p) : [];
  const envOpts = (sel) => `<option value="">${p?.activeEnv ? 'Active environment' : 'No environment'}</option>${(p?.envs || []).map((e) => `<option value="${esc(e.id)}" ${e.id === sel ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}`;
  const col = (side) => `<div class="compare-col"><div class="url-bar"><b>${side.toUpperCase()}</b>
      <select id="ab-env-${side}" class="grow">${envOpts(ab[`env${side.toUpperCase()}`])}</select></div>
      <div class="response-panel" id="slot-res-${side === 'a' ? 0 : 1}">${responseHtml(ab.results[side === 'a' ? 0 : 1], findReq(ab.reqId)?.r.assertions, side === 'a' ? 0 : 1, resTab)}</div></div>`;
  const [ra, rb] = ab.results;
  return `<div class="ab-head"><select id="ab-req" class="grow"><option value="">— pick a request —</option>${reqs.map((r) => `<option value="${esc(r.id)}" ${r.id === ab.reqId ? 'selected' : ''}>${esc(r.method)} ${esc(r.name)}</option>`).join('')}</select>
      <button class="btn-primary small" data-action="ab-send" ${ab.reqId ? '' : 'disabled'}>Send to both</button></div>
    ${ra && rb && !ra.error && !rb.error ? envSummary(ra, rb) : ''}
    <div class="ab-cols">${col('a')}${col('b')}${ra?.body != null && rb?.body != null ? bodyDiff(ra, rb) : ''}</div>`;
}

export function renderCompare() {
  const el = $('compare-layout');
  const on = S.page === 'compare';
  el.classList.toggle('on', on);
  if (!on) { el.innerHTML = ''; return; }
  const mode = S.compare.mode || 'requests';
  const modes = `<div class="compare-modes"><button class="tab${mode === 'requests' ? ' active' : ''}" data-action="compare-mode" data-mode="requests">Two requests</button>
    <button class="tab${mode === 'envs' ? ' active' : ''}" data-action="compare-mode" data-mode="envs">Same request, two environments</button></div>`;
  if (mode === 'envs') { el.innerHTML = `<div class="compare-wrap">${modes}${envsMode()}</div>`; return; }
  const { slots, results, resTab = 'body' } = S.compare;
  const options = DB.projects.flatMap((p) => allRequests(p).map((r) => ({ id: r.id, label: `${p.name} / ${r.name}` })));
  const column = (si) => {
    const loc = slots[si] && findReq(slots[si]);
    return `<div class="compare-col"><div class="url-bar">
      <select data-slot="${si}" id="slot-sel-${si}" class="grow"><option value="">— pick request —</option>${options.map((o) => `<option value="${esc(o.id)}" ${o.id === slots[si] ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
      <button class="btn-primary small" data-action="slot-send" data-slot="${si}">Send</button></div>
      ${loc ? `<div style="padding:8px 12px" class="hint">${esc(loc.r.method)} ${esc(loc.r.url)}</div>` : ''}
      <div class="response-panel" id="slot-res-${si}">${responseHtml(results[si], loc?.r.assertions, si, resTab)}</div></div>`;
  };
  const diff = results[0]?.body != null && results[1]?.body != null ? bodyDiff(results[0], results[1]) : '';
  el.innerHTML = `<div class="compare-wrap">${modes}<div class="ab-cols">${column(0)}${column(1)}${diff}</div></div>`;
}
