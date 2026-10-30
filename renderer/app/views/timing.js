// Timing waterfall for a response (main/http.js measures each phase of every send).
// timing: { dns, tcp, tls, request, wait, download, total, reused, remoteAddress, httpVersion, overall,
//           redirects: [{ url, status, timing }] }
import { esc } from '../../shared/html.js';

const PHASES = [
  ['dns', 'DNS lookup', 'Resolving the host name'],
  ['tcp', 'TCP connect', 'Opening the connection'],
  ['tls', 'TLS handshake', 'Negotiating HTTPS'],
  ['request', 'Request sent', 'Writing headers and body'],
  ['wait', 'Waiting (TTFB)', 'Server processing until the first response byte'],
  ['download', 'Content download', 'Receiving the response body'],
];
const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`);

export function timingTitle(t) {
  if (!t) return '';
  return PHASES.map(([k, label]) => `${label}: ${fmt(t[k])}`).join('\n') + (t.redirects?.length ? `\n+ ${t.redirects.length} redirect(s)` : '');
}

// One hop's phases as offset bars on a shared scale (scale = the longest hop's total, so hops compare).
function hopHtml(t, scale, heading) {
  let offset = 0;
  const rows = PHASES.map(([k, label, help]) => {
    const ms = t[k] || 0;
    const left = (offset / scale) * 100, width = Math.max((ms / scale) * 100, ms > 0 ? 0.4 : 0);
    offset += ms;
    return `<div class="timing-row" title="${esc(help)}"><span class="timing-label">${label}</span>
      <span class="timing-track"><span class="timing-bar timing-${k}" style="left:${left}%;width:${width}%"></span></span>
      <span class="timing-ms">${fmt(ms)}</span></div>`;
  }).join('');
  const notes = [t.reused ? 'connection reused (no DNS/TCP/TLS)' : '', t.remoteAddress ? `remote ${esc(t.remoteAddress)}` : '', t.httpVersion ? `HTTP/${esc(t.httpVersion)}` : ''].filter(Boolean).join(' · ');
  return `<div class="timing-hop">${heading}${rows}
    <div class="timing-row timing-total"><span class="timing-label">Total</span><span class="timing-track"></span><span class="timing-ms">${fmt(t.total)}</span></div>
    ${notes ? `<div class="hint">${notes}</div>` : ''}</div>`;
}

export function timingHtml(t) {
  if (!t) return '<p class="hint">No timing for this response (it was recorded before timing was added).</p>';
  const hops = [...(t.redirects || []), { url: '', status: null, timing: t }];
  const scale = Math.max(...hops.map((h) => h.timing.total), 0.1);
  const many = hops.length > 1;
  return `${many ? `<p class="mb-6 hint">${hops.length - 1} redirect${hops.length > 2 ? 's' : ''}, ${fmt(t.overall)} overall</p>` : ''}
    ${hops.map((h, i) => hopHtml(h.timing, scale, many ? `<div class="timing-hop-head">${i < hops.length - 1 ? `${h.status} → ` : 'Final: '}<code>${esc(h.url || '')}</code></div>` : '')).join('')}`;
}
