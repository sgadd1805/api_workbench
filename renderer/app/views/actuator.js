// Spring Boot Actuator page (S.page === 'actuator'): health, environment, mappings and loggers of a
// running app. State: S.actuator (actions/actuator.js).
import { esc } from '../../shared/html.js';
import { icon } from '../../shared/icons.js';
import { S, currentProject } from '../store.js';
import { healthRows, envRows, mappingRows, loggerRows, isInternalMapping } from '../actuator.js';

const TABS = [['health', 'Health'], ['env', 'Environment'], ['mappings', 'Mappings'], ['loggers', 'Loggers']];
const statusCls = (s) => (s === 'UP' ? 'status-ok' : s === 'DOWN' || s === 'OUT_OF_SERVICE' ? 'status-err' : 'hint');
const matches = (q, ...fields) => !q || fields.some((f) => String(f || '').toLowerCase().includes(q));

function healthHtml(data) {
  const rows = healthRows(data);
  return `<table class="run-table act-table">${rows.map((r) => `<tr><td style="padding-left:${8 + r.depth * 16}px">${esc(r.name)}</td><td><b class="${statusCls(r.status)}">${esc(r.status)}</b></td>
    <td class="hint mono">${r.details ? esc(JSON.stringify(r.details).slice(0, 300)) : ''}</td></tr>`).join('')}</table>`;
}

function envHtml(data, q) {
  const rows = envRows(data).filter((r) => matches(q, r.name, r.value, r.source));
  return `<table class="run-table act-table"><tr><th>Property</th><th>Value</th><th>Source</th></tr>${rows.slice(0, 1500).map((r) => `<tr class="${r.overridden ? 'act-overridden' : ''}">
    <td class="mono">${esc(r.name)}</td><td class="mono act-value">${esc(r.value)}</td><td class="hint" title="${esc(r.origin)}">${esc(r.source)}${r.overridden ? ' <span class="hint">(overridden)</span>' : ''}</td></tr>`).join('')}</table>
    ${rows.length > 1500 ? `<p class="hint">Showing 1,500 of ${rows.length}; narrow the filter.</p>` : ''}
    <p class="hint">Values shown as <code>******</code> are masked by the app (management.endpoint.env.show-values).</p>`;
}

function mappingsHtml(data, q) {
  const A = S.actuator;
  const all = mappingRows(data).filter((m) => A.showInternal || !isInternalMapping(m));
  const rows = all.filter((m) => matches(q, m.path, m.handler, m.methods.join(' ')));
  return `<div class="spec-row"><label class="hint"><input type="checkbox" id="act-internal" ${A.showInternal ? 'checked' : ''}/> Include actuator / error / docs endpoints</label><span class="grow"></span>
      <button class="btn-primary small" data-action="act-create" ${rows.length ? '' : 'disabled'}>Create requests for ${A.picked.size || rows.length}${A.picked.size ? ' selected' : ' shown'}…</button></div>
    <table class="run-table act-table"><tr><th><input type="checkbox" id="act-pick-all" ${rows.length && rows.every((m) => A.picked.has(m.methods.join(',') + ' ' + m.path)) ? 'checked' : ''} aria-label="Select all shown"/></th><th>Method</th><th>Path</th><th>Handler</th></tr>
    ${rows.map((m) => { const k = m.methods.join(',') + ' ' + m.path; return `<tr><td><input type="checkbox" class="act-pick" data-key="${esc(k)}" ${A.picked.has(k) ? 'checked' : ''} aria-label="Select ${esc(k)}"/></td>
      <td>${m.methods.map((x) => `<span class="method-tag m-${esc(x)}">${esc(x)}</span>`).join(' ')}${m.anyMethod ? ' <span class="hint">(any)</span>' : ''}</td>
      <td class="mono">${esc(m.path)}</td><td class="hint mono act-handler" title="${esc(m.handler)}">${esc(m.handler.split('.').slice(-1)[0])}</td></tr>`; }).join('')}</table>
    <p class="hint">${rows.length} of ${all.length} endpoints. Requests use <code>{{baseUrl}}</code>; path variables become <code>{{variables}}</code>.</p>`;
}

function loggersHtml(data, q) {
  const A = S.actuator;
  const { levels, rows } = loggerRows(data);
  const changed = Object.keys(A.changed);
  const shown = rows.filter((r) => matches(q, r.name) && (!A.onlyConfigured || r.configured || A.changed[r.name] !== undefined));
  return `${changed.length ? `<div class="act-changed warn-text">Changed in this session: ${changed.map((n) => `<code>${esc(n)}</code> → ${esc(rows.find((r) => r.name === n)?.configured || 'reset')}`).join(', ')}
      <button class="btn-ghost small" data-action="act-reset-all" title="Put every logger you changed back to its previous level">Reset all</button></div>` : ''}
    <div class="spec-row"><label class="hint"><input type="checkbox" id="act-only-configured" ${A.onlyConfigured ? 'checked' : ''}/> Only loggers with a configured level</label>
      <span class="grow"></span><input type="text" id="act-new-logger" placeholder="Another logger, e.g. com.example.payments" spellcheck="false" class="mono" style="min-width:260px"/>
      <select id="act-new-level">${levels.map((l) => `<option ${l === 'DEBUG' ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <button class="btn-ghost small" data-action="act-set-new">Set</button></div>
    <table class="run-table act-table"><tr><th>Logger</th><th>Effective</th><th>Configured</th></tr>${shown.slice(0, 800).map((r) => `<tr class="${A.changed[r.name] !== undefined ? 'act-was-changed' : ''}">
      <td class="mono">${esc(r.name)}</td><td><b class="lvl-${esc((r.effective || '').toLowerCase())}">${esc(r.effective || '')}</b></td>
      <td><select class="act-level" data-logger="${esc(r.name)}" aria-label="Level for ${esc(r.name)}"><option value="">${r.configured ? 'reset (inherit)' : '— inherit —'}</option>${levels.map((l) => `<option ${l === r.configured ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></td></tr>`).join('')}</table>
    ${shown.length > 800 ? `<p class="hint">Showing 800 of ${shown.length}; narrow the filter.</p>` : ''}`;
}

export function actuatorPageHtml() {
  const p = currentProject(), A = S.actuator;
  const q = A.filter.trim().toLowerCase();
  const d = A.data[A.tab];
  const body = A.loading ? '<p class="hint">Loading…</p>' : A.error ? `<p class="error-text">${esc(A.error)}</p>` : !d ? '<p class="hint">Enter the app\'s Actuator address and press Load.</p>'
    : { health: () => healthHtml(d), env: () => envHtml(d, q), mappings: () => mappingsHtml(d, q), loggers: () => loggersHtml(d, q) }[A.tab]();
  return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button><h3>Spring Boot Actuator${p ? `: ${esc(p.name)}` : ''}</h3></div>
    <div class="spec-row"><label class="hint" for="act-base">Actuator</label><input type="text" id="act-base" value="${esc(A.base)}" placeholder="http://localhost:8080/actuator  or  {{baseUrl}}/actuator" spellcheck="false" class="grow mono"/>
      <button class="btn-primary small" data-action="act-load">Load</button></div>
    <p class="hint">Calls go out with the project's auth, active environment and network settings. The app needs these endpoints exposed (<code>management.endpoints.web.exposure.include=health,env,mappings,loggers</code>).</p>
    <div class="tabs act-tabs">${TABS.map(([id, l]) => `<button class="tab${A.tab === id ? ' active' : ''}" data-action="act-tab" data-tab="${id}">${l}</button>`).join('')}
      ${A.tab !== 'health' ? `<input type="text" id="act-filter" value="${esc(A.filter)}" placeholder="Filter…" spellcheck="false" class="act-filter"/>` : ''}</div>
    <div class="act-body">${body}</div>`;
}
