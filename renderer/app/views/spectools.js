// Specs page extras: the drift check across all requests, the breaking-change diff against an older
// version, and the mock server panel. State lives in S.specTools (actions/spectools.js).
import { esc } from '../../shared/html.js';
import { S, currentProject } from '../store.js';
import { specAnalysis } from '../openapi/registry.js';
import { statusChoices } from '../openapi/mock.js';
import { summarizeDiff } from '../openapi/diff.js';
import { issuesHtml } from './specs.js';
import { icon } from '../../shared/icons.js';

const T = () => S.specTools;
const LEVEL_ICON = { breaking: '✗', warning: '⚠', info: '+' };
const LEVEL_CLASS = { breaking: 'assert-fail', warning: 'warn-text', info: 'hint' };

// Buttons on each spec card.
export function specCardToolsHtml(meta) {
  const m = T().mock[meta.id];
  return `<button class="btn-ghost small" data-action="spec-diff" data-id="${esc(meta.id)}" ${meta.source.type === 'file' ? '' : 'disabled title="Only for specs attached from a file in a git repository"'} title="Compare with an older version from git and list breaking changes">Compare with git…</button>
    <button class="btn-ghost small" data-action="open-fuzz" data-scope="project|${esc(currentProject()?.id || '')}" title="Send invalid and unusual values to every request matched to this project's specs">Fuzz…</button>
    <button class="btn-ghost small${m?.running ? ' active' : ''}" data-action="mock-open" data-id="${esc(meta.id)}" title="Serve this spec's examples on localhost">${m?.running ? `● Mock on :${m.port}` : 'Mock server…'}</button>`;
}

export function specToolsHtml(p) {
  return [driftHtml(), diffHtml(p), mockHtml(p)].join('');
}

function driftHtml() {
  const d = T().drift; if (!d) return '';
  const c = d.counts;
  const rows = d.rows.map(({ loc, op, request, response, error, missingVars }) => {
    const errs = [...request, ...response].filter((i) => i.level === 'error').length;
    const status = error ? `<span class="assert-fail">✗ ${esc(error)}</span>` : !op ? '<span class="hint">no matching operation</span>'
      : errs ? `<span class="assert-fail">✗ ${errs} issue${errs === 1 ? '' : 's'}</span>` : '<span class="assert-pass">✓</span>';
    const detail = op && (request.length || response.length) ? `<div class="drift-detail">${request.length ? issuesHtml(request, '') : ''}${response.length ? `<div class="hint">Last response:</div>${issuesHtml(response, '')}` : ''}</div>` : '';
    return `<tr><td><a href="#" class="link-btn" data-action="open-req" data-id="${esc(loc.r.id)}"><span class="method-tag m-${esc(loc.r.method)}">${esc(loc.r.method)}</span> ${esc(loc.r.name)}</a>
        ${missingVars?.length ? `<div class="hint">undefined: {{${esc(missingVars.join('}}, {{'))}}}</div>` : ''}</td>
      <td>${op ? `<code>${esc(op.key)}</code>` : ''}</td><td>${status}${detail}</td></tr>`;
  }).join('');
  const uncovered = d.uncovered.length ? `<details class="drift-uncovered"><summary class="hint">${d.uncovered.length} operation${d.uncovered.length === 1 ? '' : 's'} with no request</summary>
      ${d.uncovered.map(({ spec, op }) => `<div><code>${esc(op.key)}</code> <span class="hint">${esc(op.summary || '')} · ${esc(spec.title)}</span></div>`).join('')}
      <p class="hint">Use "Create requests…" on the spec to add them.</p></details>` : '';
  return `<section class="spec-tool"><h4 class="section-title">Drift check <button class="btn-ghost small" data-action="spec-drift">Re-run</button>
      <button class="btn-ghost small" data-action="spec-tool-close" data-tool="drift">${icon('close')}</button></h4>
    <p class="hint">${c.requests} requests: <b class="${c.failing ? 'assert-fail' : 'assert-pass'}">${c.failing} with spec errors</b>, ${c.unmatched} not matched to an operation.
      Requests are checked as they'd be sent now; responses are checked from each open tab's last response. Run the collection to check every response.</p>
    <table class="run-table drift-table"><tr><th>Request</th><th>Operation</th><th>Result</th></tr>${rows}</table>${uncovered}</section>`;
}

function diffHtml(p) {
  const d = T().diff; if (!d || !p.specs.some((s) => s.id === d.specId)) return '';
  const n = summarizeDiff(d.changes);
  const byOp = new Map();
  for (const c of d.changes) { if (!byOp.has(c.op)) byOp.set(c.op, []); byOp.get(c.op).push(c); }
  const groups = [...byOp].map(([op, cs]) => `<div class="diff-op"><code>${esc(op)}</code>${cs.map((c) =>
    `<div class="${LEVEL_CLASS[c.level]}">${LEVEL_ICON[c.level]} ${c.where ? `<code>${esc(c.where)}</code> ` : ''}${esc(c.message)}</div>`).join('')}</div>`).join('');
  return `<section class="spec-tool"><h4 class="section-title">Changes in ${esc(d.title)} <button class="btn-ghost small" data-action="spec-tool-close" data-tool="diff">${icon('close')}</button></h4>
    <p class="hint">${esc(d.from)} → ${esc(d.to)}:
      <b class="${n.breaking ? 'assert-fail' : 'assert-pass'}">${n.breaking} breaking</b>, ${n.warning} to check, ${n.info} additions / compatible.</p>
    ${groups || '<p class="assert-pass">✓ No differences in operations, parameters or schemas.</p>'}</section>`;
}

function mockHtml(p) {
  const id = T().mockOpen, meta = p.specs.find((s) => s.id === id); if (!meta) return '';
  const analysis = specAnalysis(id);
  if (!analysis) return '';
  const m = T().mock[id] || {};
  const ops = analysis.operations.map((op) => {
    const ov = m.overrides?.[op.key] || '';
    return `<tr><td><span class="method-tag m-${esc(op.method)}">${esc(op.method)}</span> <code>${esc(op.path)}</code> <span class="hint">${esc(op.summary || '')}</span></td>
      <td><select class="mock-ov" data-op="${esc(op.key)}"><option value="">auto (${esc(Object.keys(op.responses).find((c) => /^2/.test(c)) || 'first')})</option>
        ${statusChoices(op).map((c) => `<option value="${c}" ${ov === c ? 'selected' : ''}>${c}${op.responses[c] ? '' : ' (generic)'}</option>`).join('')}
        <option value="drop" ${ov === 'drop' ? 'selected' : ''}>drop connection</option></select></td></tr>`;
  }).join('');
  const hits = (m.hits || []).slice(0, 50).map((h) => `<div class="mock-hit"><span class="hint">${new Date(h.at).toLocaleTimeString()}</span>
    <b>${esc(h.method)}</b> ${esc(h.url)} → <span class="${typeof h.status === 'number' && h.status < 400 ? 'status-ok' : 'status-err'}">${esc(h.status)}</span>
    <span class="hint">${h.route ? esc(h.route) : 'no route'}${h.ms != null ? ` · ${h.ms} ms` : ''}</span>${h.note ? ` <span class="${/^fault/.test(h.note) ? 'warn-text' : 'hint'}">${esc(h.note)}</span>` : ''}</div>`).join('');
  const f = m.faults || {};
  const num = (id, value, cls = 'w-50') => `<input type="text" id="${id}" value="${esc(value ?? 0)}" class="${cls}" inputmode="numeric"/>`;
  const stored = (m.store || []).filter((x) => x.count >= 0);
  const behaviour = `<div class="mock-behaviour">
      <div class="spec-row"><label><input type="checkbox" id="mock-stateful" ${m.stateful ? 'checked' : ''}/> Stateful</label>
        <span class="hint">POST stores the body (with an id); GET, PUT, PATCH and DELETE on <code>…/{id}</code> read, replace, merge and remove it; GET on the collection lists what's stored. Only operations the spec defines answer. Kept in memory until reset or stopped.</span></div>
      ${m.stateful && m.running ? `<div class="spec-row"><span class="hint">${stored.length ? `Stored: ${stored.map((x) => `${esc(x.path)} (${x.count})`).join(', ')}` : 'Nothing stored yet: answers are the examples.'}</span>
        <button class="btn-ghost small" data-action="mock-reset" data-id="${esc(id)}">Reset data</button></div>` : ''}
      <div class="spec-row"><span class="hint net-label">Faults</span>
        <label class="hint" for="mock-err-rate">Fail</label>${num('mock-err-rate', f.errorRate)}<span class="hint">% of requests with</span>
        <select id="mock-err-status">${['500', '502', '503', '504', '429'].map((c) => `<option ${f.errorStatus === c ? 'selected' : ''}>${c}</option>`).join('')}
          <option value="drop" ${f.errorStatus === 'drop' ? 'selected' : ''}>dropped connection</option><option value="hang" ${f.errorStatus === 'hang' ? 'selected' : ''}>no answer (hang)</option></select></div>
      <div class="spec-row"><span class="net-label"></span><label class="hint" for="mock-fail-first">Fail the first</label>${num('mock-fail-first', f.failFirst)}<span class="hint">call(s) to each endpoint, then succeed (retry testing; the same failure)</span>
        ${m.running && f.failFirst ? `<button class="btn-ghost small" data-action="mock-reset" data-id="${esc(id)}" title="Start counting again">Reset counts</button>` : ''}</div>
      <div class="spec-row"><span class="net-label"></span><label class="hint" for="mock-jitter">Random extra latency up to</label>${num('mock-jitter', f.jitterMs, 'w-60')}<span class="hint">ms;</span>
        ${num('mock-slow-rate', f.slowRate)}<label class="hint" for="mock-slow-rate">% of requests slower by</label>${num('mock-slow-ms', f.slowMs, 'w-70')}<span class="hint">ms</span></div>
      <p class="hint">429 and 503 faults carry <code>Retry-After: 1</code> and an <code>X-Mock-Fault</code> header. A status forced per operation or per call is never replaced by a fault.</p>
    </div>`;
  return `<section class="spec-tool"><h4 class="section-title">Mock server: ${esc(meta.title)} <button class="btn-ghost small" data-action="spec-tool-close" data-tool="mock">${icon('close')}</button></h4>
    <div class="spec-row">
      <label class="hint" for="mock-port">Port</label><input type="text" id="mock-port" value="${esc(m.running ? m.port : m.portText ?? meta.mockPort ?? '')}" placeholder="auto" class="w-70" ${m.running ? 'disabled' : ''}/>
      <label class="hint" for="mock-delay">Latency</label><input type="text" id="mock-delay" value="${m.delayMs || 0}" class="w-60"/><span class="hint">ms</span>
      <label class="hint" for="mock-all">All operations</label><select id="mock-all"><option value="">as set below</option>${['400', '401', '404', '429', '500', '503'].map((c) => `<option ${m.override === c ? 'selected' : ''}>${c}</option>`).join('')}<option value="drop" ${m.override === 'drop' ? 'selected' : ''}>drop connection</option></select>
      ${m.running ? `<button class="btn-primary danger small" data-action="mock-stop" data-id="${esc(id)}">${icon('stop')} Stop</button>` : `<button class="btn-primary small" data-action="mock-start" data-id="${esc(id)}">${icon('play')} Start</button>`}</div>
    ${m.running ? `<p class="hint">Serving on <code>${esc(m.url)}</code>
        <button class="btn-ghost small" data-action="mock-env" data-id="${esc(id)}" title="Create or update an environment named 'mock' whose {{baseUrl}} points here">Use as "mock" environment</button>
        <button class="btn-ghost small" data-action="copy-text" data-text="${esc(m.url)}">Copy URL</button></p>` : ''}
    <p class="hint">Bodies are the spec's examples (or generated from its schemas). Force a status per call with the <code>X-Mock-Status: 503</code> header or <code>?__status=503</code>.</p>
    ${behaviour}
    <table class="run-table mock-table"><tr><th>Operation</th><th>Responds with</th></tr>${ops}</table>
    ${hits ? `<h4 class="mt-10 section-title">Requests</h4><div class="mock-hits">${hits}</div>` : ''}</section>`;
}
