// Response-time trend views (timings.js): the sparkline and "slower than usual" badge on a response's
// status line, and the chart with p50 / p95 at the top of its History tab.
import { esc } from '../../shared/html.js';
import { samplesFor, stats, slowness } from '../timings.js';

const ms = (n) => (n == null ? '–' : n >= 10000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
export const statsTitle = (st) => `p50 ${ms(st.p50)} · p95 ${ms(st.p95)} over ${st.n} successful run${st.n === 1 ? '' : 's'}`;

// "▲ 2.8× slower than usual" for a slowness verdict (res.slow), or ''.
export function slowBadgeHtml(slow, { short = false } = {}) {
  if (!slow) return '';
  const title = `Markedly slower than this request's usual runs in this environment: p50 ${ms(slow.p50)}, p95 ${ms(slow.p95)} over ${slow.n} runs`;
  return `<span class="slow-badge" title="${esc(title)}">▲ ${slow.ratio}×${short ? '' : ' slower than usual'}</span>`;
}

// The last 30 runs of the request in this environment as a tiny line; the latest point is red when slow.
export function sparklineHtml(reqId, envId, slow) {
  const list = samplesFor(reqId, envId).slice(-30);
  if (list.length < 2) return '';
  const W = 80, H = 18, P = 2;
  const max = Math.max(...list.map((s) => s.ms)), min = Math.min(...list.map((s) => s.ms));
  const x = (i) => P + (i * (W - 2 * P)) / (list.length - 1);
  const y = (v) => H - P - (max === min ? (H - 2 * P) / 2 : ((v - min) * (H - 2 * P)) / (max - min));
  const pts = list.map((s, i) => `${x(i).toFixed(1)},${y(s.ms).toFixed(1)}`).join(' ');
  const last = list.at(-1);
  return `<span class="trend-spark" title="${esc(`Response time, last ${list.length} runs · ${statsTitle(stats(samplesFor(reqId, envId)))}`)}" data-action="restab" data-tab="history">
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts}" fill="none" class="trend-line"/>
    <circle cx="${x(list.length - 1).toFixed(1)}" cy="${y(last.ms).toFixed(1)}" r="2.2" class="${slow ? 'trend-pt-slow' : last.status >= 400 ? 'trend-pt-err' : 'trend-pt'}"/></svg></span>`;
}

// The History tab's chart: the last 100 runs (each judged against the runs before it), dashed p50 and
// p95 lines, the numbers, and switches for this environment / all environments and Reset.
export function trendSectionHtml(reqId, envId, { allEnvs = false, envName = '' } = {}) {
  const all = samplesFor(reqId, envId, { allEnvs });
  const scope = `<span class="row gap-6 items-center"><button class="btn-ghost small${allEnvs ? '' : ' compare-active'}" data-action="trend-envs" data-all="0" aria-pressed="${!allEnvs}">${esc(envName || 'This environment')}</button>
    <button class="btn-ghost small${allEnvs ? ' compare-active' : ''}" data-action="trend-envs" data-all="1" aria-pressed="${allEnvs}">All environments</button></span>`;
  const head = (extra) => `<div class="trend-head"><h4 class="section-title">Response time</h4>${scope}<span class="grow"></span>${extra}</div>`;
  if (all.length < 2) return `<div class="trend-box">${head('')}<p class="hint">The response-time trend appears after a few sends of this request${allEnvs ? '' : ' in this environment'}.</p></div>`;
  const list = all.slice(-100), st = stats(all);
  const W = 600, H = 130, L = 8, R = 92, T = 8, B = 16;
  const top = Math.max(...list.map((s) => s.ms), st.p95 || 0) * 1.1 || 1;
  const x = (i) => L + (list.length === 1 ? 0 : (i * (W - L - R)) / (list.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const offset = all.length - list.length;
  // Each run against the runs before it in its own environment.
  const judge = (s, i) => slowness(s.ms, all.slice(0, offset + i).filter((b) => b.env == null || s.env == null || b.env === s.env));
  const points = list.map((s, i) => {
    const slow = judge(s, i);
    const cls = s.status >= 400 ? 'trend-pt-err' : slow ? 'trend-pt-slow' : 'trend-pt';
    const tip = `${new Date(s.at).toLocaleString()} · ${ms(s.ms)} · HTTP ${s.status}${slow ? ` · ${slow.ratio}× slower than usual` : ''}`;
    return `<circle cx="${x(i).toFixed(1)}" cy="${y(s.ms).toFixed(1)}" r="${slow ? 3.2 : 2.4}" class="${cls}"><title>${esc(tip)}</title></circle>`;
  }).join('');
  const line = list.map((s, i) => `${x(i).toFixed(1)},${y(s.ms).toFixed(1)}`).join(' ');
  const mark = (v, label, cls) => (v == null ? '' : `<line x1="${L}" x2="${W - R + 4}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="${cls}"/><text x="${W - R + 8}" y="${(y(v) + 4).toFixed(1)}" class="trend-label">${label} ${esc(ms(v))}</text>`);
  const when = (s) => new Date(s.at).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const svg = `<svg class="trend-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Response time of the last ${list.length} runs: ${statsTitle(st)}`)}">
    <line x1="${L}" x2="${W - R + 4}" y1="${H - B}" y2="${H - B}" class="trend-axis"/>
    ${mark(st.p95, 'p95', 'trend-p95')}${mark(st.p50, 'p50', 'trend-p50')}
    <polyline points="${line}" fill="none" class="trend-line"/>${points}
    <text x="${L}" y="${H - 3}" class="trend-label">${esc(when(list[0]))}</text><text x="${W - R}" y="${H - 3}" class="trend-label" text-anchor="end">${esc(when(list.at(-1)))}</text></svg>`;
  const fact = (label, v) => `<span><span class="hint">${label}</span> ${v}</span>`;
  const slowCount = list.filter((s, i) => s.status < 400 && judge(s, i)).length;
  return `<div class="trend-box">${head(`<button class="btn-ghost small" data-action="trend-reset" data-id="${esc(reqId)}" title="Forget this request's response times (History keeps its runs)">Reset</button>`)}
    ${svg}<div class="trend-facts">${fact('Runs', all.length)}${fact('p50', ms(st.p50))}${fact('p95', ms(st.p95))}${fact('Min', ms(st.min))}${fact('Max', ms(st.max))}${fact('Last', ms(st.last))}
      ${slowCount ? `<span class="slow-badge">▲ ${slowCount} slow run${slowCount === 1 ? '' : 's'}</span>` : ''}</div></div>`;
}
