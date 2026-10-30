// A response's Trace tab: the spans the app exported for this request's trace (main/otel.js), as a
// waterfall. Errors, slow spans, database calls and outgoing HTTP calls are marked; click a span for
// its attributes and events.
import { esc } from '../../shared/html.js';
import { S } from '../store.js';

const SERVICE_COLORS = ['#4a9eff', '#c586c0', '#4ec9b0', '#ce9178', '#dcdcaa', '#9cdcfe', '#f48771', '#b5cea8'];
const colorOf = (name) => SERVICE_COLORS[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % SERVICE_COLORS.length];
const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`);

// Spans in tree order (parents before children, siblings by start) with their depth.
export function treeOrder(spans) {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const kids = new Map();
  for (const s of spans) { const p = s.parentId && byId.has(s.parentId) ? s.parentId : null; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(s); }
  for (const list of kids.values()) list.sort((a, b) => a.start - b.start);
  const out = [];
  const walk = (s, depth) => { out.push({ span: s, depth }); for (const c of kids.get(s.spanId) || []) walk(c, depth + 1); };
  for (const r of kids.get(null) || []) walk(r, 0);
  return out;
}

// What a span does, in a few words: the DB statement, the outgoing call, or the route.
export function spanLabel(s) {
  const a = s.attributes || {};
  if (a['db.system']) return { tag: 'DB', text: `${a['db.system']}${a['db.statement'] || a['db.query.text'] ? ': ' + String(a['db.statement'] || a['db.query.text']).slice(0, 120) : ''}` };
  const method = a['http.request.method'] || a['http.method'];
  const url = a['url.full'] || a['http.url'];
  if (s.kind === 'client' && (method || url)) return { tag: 'HTTP', text: `${method || ''} ${url || a['server.address'] || ''}`.trim() };
  if (a['messaging.system']) return { tag: 'MSG', text: `${a['messaging.system']} ${a['messaging.destination.name'] || a['messaging.destination'] || ''}` };
  return null;
}

export function traceHtml(res, spans, { receiver, traceLink } = {}) {
  const c = res.correlation;
  if (!c) return '<p class="hint">This request wasn\'t tagged with a traceparent (correlation is off in Project settings).</p>';
  if (!spans.length) {
    return `<p class="hint">No spans received yet for trace <code>${esc(c.traceId)}</code>.</p>
      ${receiver?.running ? `<p class="hint">The receiver is listening on <code>http://localhost:${receiver.ports.http}</code> (OTLP/HTTP)${receiver.ports.grpc ? ` and <code>localhost:${receiver.ports.grpc}</code> (gRPC)` : ''}.
        Run the app with the OpenTelemetry agent exporting there — tasks started from this app get the settings automatically. Spans can take a few seconds to arrive.</p>`
        : '<p><button class="btn-primary small" data-action="otel-start">Start the trace receiver</button></p>'}
      <details><summary class="hint">Set up a Java app by hand</summary><pre class="resp-body">-javaagent:/path/to/opentelemetry-javaagent.jar
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${receiver?.ports?.http || 4318}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=my-service
OTEL_METRICS_EXPORTER=none
OTEL_LOGS_EXPORTER=none</pre></details>${traceLink ? `<p><a href="${esc(traceLink)}" target="_blank" rel="noopener">Open in your trace viewer ↗</a></p>` : ''}`;
  }
  const t0 = Math.min(...spans.map((s) => s.start)), t1 = Math.max(...spans.map((s) => s.end));
  const total = Math.max(t1 - t0, 0.001);
  const rows = treeOrder(spans);
  const slow = new Set(spans.filter((s) => s.parentId).sort((a, b) => b.ms - a.ms).slice(0, 3).filter((s) => s.ms >= total * 0.25).map((s) => s.spanId));
  const services = [...new Set(spans.map((s) => s.service))];
  const errors = spans.filter((s) => s.status.code === 'error').length;
  const sel = spans.find((s) => s.spanId === S.traceSel);
  return `<div class="trace-head"><span>${spans.length} spans · ${services.map((s) => `<span class="trace-svc" style="--svc:${colorOf(s)}">${esc(s)}</span>`).join(' ')} · ${fmt(total)}</span>
      ${errors ? `<span class="assert-fail">✗ ${errors} error span${errors === 1 ? '' : 's'}</span>` : ''}
      <span class="grow"></span><button class="btn-ghost small" data-action="otel-refresh">Refresh</button>${traceLink ? `<a href="${esc(traceLink)}" target="_blank" rel="noopener" class="hint">Open in trace viewer ↗</a>` : ''}</div>
    <div class="trace-rows">${rows.map(({ span: s, depth }) => {
      const label = spanLabel(s);
      const left = ((s.start - t0) / total) * 100, width = Math.max((s.ms / total) * 100, 0.3);
      const cls = [s.status.code === 'error' ? 'err' : '', slow.has(s.spanId) ? 'slow' : '', s.spanId === S.traceSel ? 'sel' : ''].join(' ');
      return `<div class="trace-row ${cls}" data-action="otel-select" data-id="${esc(s.spanId)}" title="${esc(`${s.service} · ${s.name} · ${fmt(s.ms)}${s.status.message ? ' · ' + s.status.message : ''}`)}">
        <div class="trace-name" style="padding-left:${depth * 14 + 4}px"><span class="trace-dot" style="background:${colorOf(s.service)}"></span>
          ${label ? `<span class="trace-tag">${label.tag}</span>` : ''}<span class="trace-span-name">${esc(label?.tag === 'DB' ? label.text : s.name)}</span>
          ${slow.has(s.spanId) ? '<span class="trace-flag slow">slow</span>' : ''}${s.status.code === 'error' ? '<span class="trace-flag err">error</span>' : ''}</div>
        <div class="trace-track"><span class="trace-bar" style="left:${left}%;width:${width}%;background:${colorOf(s.service)}"></span></div>
        <div class="trace-ms">${fmt(s.ms)}</div></div>`;
    }).join('')}</div>
    ${sel ? `<div class="trace-detail"><h4 class="section-title">${esc(sel.name)} <span class="hint">${esc(sel.service)} · ${esc(sel.kind)} · ${fmt(sel.ms)}</span></h4>
      ${sel.status.code === 'error' ? `<p class="error-text">${esc(sel.status.message || 'Error')}</p>` : ''}
      <table class="run-table trace-attrs">${Object.entries(sel.attributes).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="mono">${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</td></tr>`).join('')}</table>
      ${sel.events.length ? `<h4 class="section-title">Events</h4>${sel.events.map((e) => `<div class="hint">${fmt(e.at - t0)} · <b>${esc(e.name)}</b> ${esc(e.attributes['exception.message'] || '')}${e.attributes['exception.stacktrace'] ? `<details><summary>stack trace</summary><pre class="resp-body">${esc(e.attributes['exception.stacktrace'])}</pre></details>` : ''}</div>`).join('')}` : ''}</div>` : '<p class="hint">Click a span for its attributes.</p>'}`;
}
