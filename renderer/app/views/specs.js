// API specs: the project's Specs page, the request editor's Spec tab, and the spec check shown with a response.
import { esc } from '../../shared/html.js';
import { currentProject, findReq } from '../store.js';
import { buildRequest } from '../http.js';
import { specAnalysis, specLoadError, validateExchange } from '../openapi/registry.js';
import { operationLabel } from '../openapi/generate.js';
import { typeLabel, constraintsOf, fieldRows } from '../openapi/docs.js';
import { deref } from '../openapi/spec.js';
import { markdown } from '../../shared/markdown.js';
import { specCardToolsHtml, specToolsHtml } from './spectools.js';
import { icon } from '../../shared/icons.js';

const fmtDate = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

// ---- Specs page
export function specsPageHtml() {
  const p = currentProject();
  if (!p) return '<p class="hint">Select a project first.</p>';
  const cards = p.specs.map((s) => {
    const err = specLoadError(s.id);
    return `<div class="spec-card">
      <div class="spec-card-head"><b>${esc(s.title)}</b> <span class="hint">${esc(s.version ? 'v' + s.version : '')} · ${esc(s.specVersion || '')} · ${s.operationCount} operation${s.operationCount === 1 ? '' : 's'}</span></div>
      <div class="hint spec-source" title="${esc(s.source.location)}">${s.source.type === 'url' ? '' + icon('globe') + '' : '' + icon('file') + ''} ${esc(s.source.location)} · added ${esc(fmtDate(s.importedAt))}</div>
      ${err ? `<div class="error-text">Stored document could not be loaded: ${esc(err)}. Reload it from its source.</div>` : ''}
      <div class="spec-card-actions">
        <button class="btn-ghost small" data-action="spec-create-requests" data-id="${esc(s.id)}" ${err ? 'disabled' : ''}>Create requests…</button>
        <button class="btn-ghost small" data-action="spec-reload" data-id="${esc(s.id)}" title="Read the file / URL again">Reload</button>
        ${err ? '' : specCardToolsHtml(s)}
        <button class="btn-ghost small" data-action="spec-remove" data-id="${esc(s.id)}">Remove</button></div></div>`;
  }).join('');
  return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button><h3>API specs: ${esc(p.name)}</h3></div>
    <p class="mb-10 hint">Attach Swagger 2 / OpenAPI 3 documents (JSON or YAML) to check this project's requests and responses
      against them, and to create requests from their operations. Requests are matched to operations by method and URL,
      or by the link set when they were created from a spec (change it in the request's Spec tab).</p>
    <div class="row gap-6 mb-14 wrap">
      <button class="btn-primary small" data-action="specs-find" title="Search a code folder for swagger/openapi files">Find in project folder…</button>
      <button class="btn-ghost small" data-action="specs-add-file">Add file…</button>
      <button class="btn-ghost small" data-action="specs-add-url" title="e.g. a running app's /v3/api-docs or /swagger.json">Add from URL…</button>
      ${p.specs.length ? '<button class="btn-ghost small" data-action="spec-drift" title="Check every request of this project against the specs, without sending">Check all requests</button>' : ''}</div>
    ${cards || '<p class="hint">No specs attached yet.</p>'}
    ${specToolsHtml(p)}`;
}

// ---- helpers shared by the Spec tab and the response
export function issuesHtml(issues, okText) {
  if (!issues.length) return `<div class="assert-pass">✓ ${esc(okText)}</div>`;
  return issues.map((i) => `<div class="${i.level === 'error' ? 'assert-fail' : 'warn-text'}">${i.level === 'error' ? '✗' : '⚠'} <code>${esc(i.where)}</code> ${esc(i.message)}</div>`).join('');
}
const errorCount = (issues) => issues.filter((i) => i.level === 'error').length;

// Live check of the open request (before sending). → validateExchange result, or null without specs.
export function currentSpecCheck(r) {
  const loc = findReq(r.id); if (!loc?.p.specs.length) return null;
  try { return validateExchange(loc, buildRequest(loc), null); } catch { return null; }
}

// Number shown on the Spec tab: request errors, or '' when there's nothing to say.
export function specTabBadge(r) {
  const check = currentSpecCheck(r);
  if (!check) return '';
  if (!check.match) return '<span class="hint">?</span>';
  const n = errorCount(check.request);
  return n ? `<span class="badge-err">${n}</span>` : '<span class="assert-pass">✓</span>';
}

function fieldsTable(schema, root) {
  const rows = fieldRows(schema, root);
  if (!rows.length) return `<div class="hint">${esc(typeLabel(schema, root))}</div>`;
  return `<table class="spec-params spec-fields"><tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr>${rows.map((f) =>
    `<tr><td><code>${esc(f.path)}</code></td><td>${esc(f.type)}</td><td>${f.required ? '<span class="badge-err">required</span>' : ''}</td>
      <td>${f.description ? `<div class="md">${markdown(f.description)}</div>` : ''}${f.constraints.length ? `<div class="hint">${esc(f.constraints.join(' · '))}</div>` : ''}</td></tr>`).join('')}</table>`;
}

function contentHtml(content, root) {
  return Object.entries(content || {}).map(([mt, m]) =>
    `<div class="spec-media"><code>${esc(mt)}</code> ${esc(typeLabel(m.schema, root))}</div>${m.schema ? fieldsTable(m.schema, root) : ''}`).join('');
}

// The operation's documentation: description, parameters, body fields, responses.
function docsHtml(op, root) {
  const params = op.parameters.length ? `<h4 class="section-title">Parameters</h4><table class="spec-params"><tr><th>Name</th><th>In</th><th>Type</th><th></th><th>Description</th></tr>${op.parameters.map((p) => {
    const s = deref(root, p.schema) || {};
    const extra = constraintsOf(s);
    return `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.in)}</td><td>${esc(typeLabel(p.schema, root))}</td><td>${p.required ? '<span class="badge-err">required</span>' : ''}</td>
      <td>${p.description ? `<div class="md">${markdown(p.description)}</div>` : ''}${extra.length ? `<div class="hint">${esc(extra.join(' · '))}</div>` : ''}</td></tr>`;
  }).join('')}</table>` : '';
  const body = op.requestBody ? `<h4 class="section-title">Request body${op.requestBody.required ? ' <span class="badge-err">required</span>' : ''}
      <button class="btn-ghost small" data-action="spec-example-body" style="margin-left:6px">Insert example body</button></h4>
    ${op.requestBody.description ? `<div class="md">${markdown(op.requestBody.description)}</div>` : ''}${contentHtml(op.requestBody.content, root)}` : '';
  const responses = Object.entries(op.responses).map(([code, r]) => {
    const hasContent = Object.keys(r.content || {}).length;
    return `<details class="spec-response"${code.startsWith('2') ? ' open' : ''}><summary><span class="${/^[23]/.test(code) ? 'status-ok' : code === 'default' ? 'hint' : 'status-err'}">${esc(code)}</span>
      ${esc((r.description || '').split('\n')[0].slice(0, 120))}${hasContent ? '' : ' <span class="hint">(no body)</span>'}</summary>
      ${r.description && r.description.length > 120 ? `<div class="md">${markdown(r.description)}</div>` : ''}${contentHtml(r.content, root)}</details>`;
  }).join('');
  return `${op.description ? `<div class="md spec-desc">${markdown(op.description)}</div>` : ''}
    ${params}${body}
    ${responses ? `<h4 class="section-title">Responses</h4>${responses}` : ''}`;
}

export function specTabHtml(r) {
  const loc = findReq(r.id);
  const specs = loc?.p.specs || [];
  if (!specs.length) return '<p class="hint">No API specs are attached to this project. Add one from the top bar → <b>Specs</b>.</p>';
  if (specs.some((s) => !specAnalysis(s.id) && !specLoadError(s.id))) return '<p class="hint">Loading specs…</p>';
  const check = currentSpecCheck(r);
  const picker = `<select id="spec-op-select" style="max-width:100%"><option value="">Auto: match by method + URL</option>${specs.map((s) => {
    const a = specAnalysis(s.id); if (!a) return '';
    return `<optgroup label="${esc(s.title)}">${a.operations.map((op) => {
      const value = `${s.id}|${op.key}`;
      return `<option value="${esc(value)}" ${r.spec && `${r.spec.specId}|${r.spec.opKey}` === value ? 'selected' : ''}>${esc(operationLabel(op))}</option>`;
    }).join('')}</optgroup>`;
  }).join('')}</select>`;
  if (!check?.match) {
    return `<div class="spec-row"><label class="hint">Operation</label>${picker}</div>
      <p class="warn-text">⚠ No operation in ${specs.map((s) => esc(s.title)).join(', ')} matches <code>${esc(r.method)}</code> for this URL. Pick one above, or check the URL path.</p>`;
  }
  const { op, meta, analysis, linked } = check.match;
  return `<div class="spec-row"><label class="hint">Operation</label>${picker}</div>
    <div class="spec-op"><span class="method-tag m-${esc(op.method)}">${esc(op.method)}</span> <code>${esc(op.path)}</code>
      ${op.summary ? `<b>${esc(op.summary)}</b>` : ''}${op.deprecated ? ' <span class="warn-text">deprecated</span>' : ''}
      <span class="hint">· ${esc(meta.title)} · ${linked ? 'linked' : 'matched by URL'}${op.operationId ? ` · ${esc(op.operationId)}` : ''}${op.tags.length ? ` · ${op.tags.map(esc).join(', ')}` : ''}</span></div>
    <div class="spec-issues"><div class="hint" style="margin-bottom:2px">Request as it would be sent now <button class="btn-ghost small" data-action="spec-recheck">Re-check</button></div>
      ${issuesHtml(check.request, 'Request matches the spec')}</div>
    <div class="spec-docs">${docsHtml(op, analysis.doc)}</div>`;
}

// One line under the URL bar: which operation this is, with its summary (full docs in the Spec tab).
export function opSummaryHtml(r) {
  const check = currentSpecCheck(r);
  if (!check?.match) return '';
  const { op } = check.match;
  const firstLine = (op.description || '').split('\n').find((l) => l.trim()) || '';
  const text = op.summary || firstLine;
  return `<div class="op-summary" data-action="side-open" data-tab="spec" title="Show the full documentation in the side panel">
    <span class="hint">ⓘ</span> <b>${esc(text || op.operationId || op.key)}</b>${op.summary && firstLine && firstLine !== op.summary ? ` <span class="hint">— ${esc(firstLine.slice(0, 160))}</span>` : ''}${op.deprecated ? ' <span class="warn-text">deprecated</span>' : ''}</div>`;
}

// ---- after a send: res.validation (see actions/core.js) → summary lines in the response pane
export function validationHtml(v) {
  if (!v) return '';
  if (!v.op) return '<div class="warn-text">⚠ Spec: no operation matches this request</div>';
  const part = (label, issues) => (issues.length ? `<span class="${errorCount(issues) ? 'assert-fail' : 'warn-text'}">${label} ${errorCount(issues) ? '✗' : '⚠'} ${issues.length}</span>` : `<span class="assert-pass">${label} ✓</span>`);
  const details = [...v.request.map((i) => ({ ...i, where: 'request ' + i.where })), ...v.response.map((i) => ({ ...i, where: 'response ' + i.where }))];
  return `<div class="spec-result"><span class="hint">Spec <code>${esc(v.op)}</code>:</span> ${part('request', v.request)} ${part('response', v.response)}</div>
    ${details.length ? `<details class="spec-details"${errorCount(details) ? ' open' : ''}><summary class="hint">${details.length} issue${details.length === 1 ? '' : 's'}</summary>${issuesHtml(details.slice(0, 50), '')}${details.length > 50 ? `<div class="hint">…and ${details.length - 50} more</div>` : ''}</details>` : ''}`;
}
