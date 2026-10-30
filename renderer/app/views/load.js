// Load test page (S.page === 'load'): settings, live progress, latency stats and charts.
import { esc } from '../../shared/html.js';
import { S, findReq } from '../store.js';
import { icon } from '../../shared/icons.js';

function histogramSvg(h) {
  const max = Math.max(1, ...h.map((b) => b.count));
  const w = 600, ht = 120, bw = w / h.length;
  return `<svg class="load-chart" viewBox="0 0 ${w} ${ht + 18}" role="img" aria-label="Latency histogram">
    ${h.map((b, i) => { const bh = (b.count / max) * ht; return `<rect x="${i * bw + 1}" y="${ht - bh}" width="${bw - 2}" height="${bh}" class="bar"><title>${b.from}–${b.to} ms: ${b.count}</title></rect>`; }).join('')}
    <text x="0" y="${ht + 14}" class="axis">${h[0]?.from ?? 0} ms</text><text x="${w}" y="${ht + 14}" text-anchor="end" class="axis">${h.at(-1)?.to ?? 0} ms</text></svg>`;
}

function timelineSvg(tl) {
  if (tl.length < 2) return '';
  const w = 600, ht = 90;
  const maxN = Math.max(1, ...tl.map((t) => t.count)), maxMs = Math.max(1, ...tl.map((t) => t.avgMs));
  const x = (i) => (i / (tl.length - 1)) * w;
  const line = (key, max) => tl.map((t, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${(ht - (t[key] / max) * ht).toFixed(1)}`).join(' ');
  return `<svg class="load-chart" viewBox="0 0 ${w} ${ht + 18}" role="img" aria-label="Requests per second and latency over time">
    <path d="${line('count', maxN)}" class="line rps"/><path d="${line('avgMs', maxMs)}" class="line ms"/>
    <text x="0" y="${ht + 14}" class="axis">0 s</text><text x="${w}" y="${ht + 14}" text-anchor="end" class="axis">${tl.length} s</text></svg>
    <div class="hint"><span class="legend rps"></span> requests / s (max ${maxN}) <span class="legend ms"></span> avg latency (max ${maxMs} ms)</div>`;
}

export function loadPageHtml() {
  const L = S.load;
  const loc = L.reqId && findReq(L.reqId);
  if (!loc) return '<div class="page-head"><button class="btn-ghost small" data-action="close-page">' + icon('back') + ' Back</button><h3>Load test</h3></div><p class="hint">Open a request, then choose Load test from its ⋯ menu or the command palette.</p>';
  const st = L.stats;
  const stat = (label, value) => `<div class="load-stat"><div class="hint">${label}</div><div class="load-value">${value}</div></div>`;
  return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button><h3>Load test: <span class="method-tag m-${esc(loc.r.method)}">${esc(loc.r.method)}</span> ${esc(loc.r.name)}</h3></div>
    <div class="spec-row">
      <label class="hint" for="load-total">Requests</label><input type="text" id="load-total" value="${L.total}" class="w-70" ${L.durationSec ? 'disabled' : ''}/>
      <label class="hint" for="load-duration">or for</label><input type="text" id="load-duration" value="${L.durationSec || ''}" placeholder="—" class="w-50"/><span class="hint">seconds</span>
      <label class="ml-10 hint" for="load-concurrency">Concurrency</label><input type="text" id="load-concurrency" value="${L.concurrency}" class="w-50"/>
      ${L.running ? '<button class="btn-primary danger small" data-action="load-stop">' + icon('stop') + ' Stop</button>' : '<button class="btn-primary small" data-action="load-start">' + icon('play') + ' Start</button>'}
      ${L.running ? `<span class="hint">${L.done}${L.target ? ' / ' + L.target : ''} sent…</span>` : ''}</div>
    <p class="mb-10 hint">Uses the request as it would be sent now (environment, auth, network settings); scripts don't run and responses aren't added to History.
      Only load-test servers you're allowed to.</p>
    ${st ? `<div class="load-stats">${stat('Requests', st.count)}${stat('OK (&lt;400)', st.ok)}${stat('Failed', `<span class="${st.failed ? 'assert-fail' : ''}">${st.failed}</span>`)}${stat('Throughput', `${st.rps}/s`)}
        ${stat('p50', `${st.p50} ms`)}${stat('p90', `${st.p90} ms`)}${stat('p95', `${st.p95} ms`)}${stat('p99', `${st.p99} ms`)}${stat('min / max', `${st.min} / ${st.max} ms`)}${stat('mean', `${st.mean} ms`)}</div>
      <div class="my-8 hint">Status codes: ${Object.entries(st.statuses).map(([c, n]) => `<b class="${c < 400 ? 'status-ok' : 'status-err'}">${c}</b> × ${n}`).join(', ') || '—'}
        ${Object.keys(st.errors).length ? ` · Errors: ${Object.entries(st.errors).map(([e, n]) => `${esc(e)} × ${n}`).join(', ')}` : ''}</div>
      <h4 class="section-title">Latency distribution</h4>${histogramSvg(st.histogram)}
      <h4 class="mt-10 section-title">Over time</h4>${timelineSvg(st.timeline)}` : ''}`;
}
