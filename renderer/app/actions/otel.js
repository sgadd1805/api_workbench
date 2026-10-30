// The OpenTelemetry trace receiver (main/otel.js): start / stop, the status bar control, spans for the
// open response's Trace tab, and OTEL_* settings for tasks started while it runs.
// DB.settings.otel: { autoStart, httpPort, grpcPort }
import { notify } from '../../shared/notify.js';
import { copyText } from '../../shared/html.js';
import { DB, S, saveDB, activeTab } from '../store.js';
import { renderResponsePanel, renderStatusBar, registerStatusItem } from '../views/index.js';
import { openMenu } from '../views/menu.js';

const api = () => window.electronAPI;
const settings = () => (DB.settings.otel ||= { autoStart: false, httpPort: 4318, grpcPort: 4317 });
export const traceSpans = new Map(); // trace id → spans (filled on demand for open responses)

export async function startReceiver() {
  const o = settings();
  const res = await api().otelStart({ httpPort: o.httpPort, grpcPort: o.grpcPort });
  if (!res.ok) { notify(`Trace receiver: ${res.error}`, 'error', 8000); return false; }
  S.otel = { running: true, ports: res.ports };
  if (res.ports.grpcError) notify(`Trace receiver: gRPC on ${o.grpcPort} unavailable (${res.ports.grpcError}); OTLP/HTTP works`, 'error', 8000);
  renderStatusBar(); renderResponsePanel();
  return true;
}

export async function stopReceiver() {
  await api().otelStop(); S.otel = { running: false, ports: {} };
  renderStatusBar(); renderResponsePanel();
}

export async function loadTrace(res, { force = false } = {}) {
  const id = res?.correlation?.traceId; if (!id) return;
  if (traceSpans.has(id) && !force) return;
  traceSpans.set(id, await api().otelTrace(id));
  if (activeTab()?.response === res && activeTab().resTab === 'trace') renderResponsePanel();
}

// OTEL_* variables for a task, so its OpenTelemetry agent / SDK exports to the receiver (only while it runs,
// and never overriding the task's own settings).
export function otelEnvFor(task) {
  if (!S.otel?.running) return [];
  const rows = {
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${S.otel.ports.http}`, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_SERVICE_NAME: task.name, OTEL_TRACES_EXPORTER: 'otlp', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none',
  };
  return Object.entries(rows).filter(([k]) => !(task.env || []).some((r) => r.on && r.k === k)).map(([k, v]) => ({ k, v, on: true }));
}

export function initOtel() {
  S.otel = { running: false, ports: {} };
  api().onOtelSpans((ids) => {
    const res = activeTab()?.response;
    for (const id of ids) if (traceSpans.has(id) || res?.correlation?.traceId === id) traceSpans.delete(id);
    if (res?.correlation && ids.includes(res.correlation.traceId) && activeTab().resTab === 'trace') loadTrace(res, { force: true });
    else if (res?.correlation && ids.includes(res.correlation.traceId)) renderResponsePanel(); // the tab label shows the span count
  });
  registerStatusItem(() => (S.otel?.running ? `<button class="status-item" data-action="otel-menu" title="OpenTelemetry trace receiver">◉ traces :${S.otel.ports.http}</button>` : ''));
  if (settings().autoStart) startReceiver();
}

export const otelActions = {
  'otel-start'() { startReceiver(); },
  'otel-refresh'() { loadTrace(activeTab()?.response, { force: true }); },
  'otel-select'(d) { S.traceSel = S.traceSel === d.id ? null : d.id; renderResponsePanel(); },
  'otel-menu'(_d, el) {
    const o = settings(), on = S.otel?.running;
    const env = `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${S.otel?.ports?.http || o.httpPort}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\nOTEL_METRICS_EXPORTER=none\nOTEL_LOGS_EXPORTER=none`;
    openMenu([
      { head: on ? `Trace receiver: OTLP/HTTP :${S.otel.ports.http}${S.otel.ports.grpc ? `, gRPC :${S.otel.ports.grpc}` : ''}` : 'Trace receiver (stopped)' },
      on ? { label: 'Stop receiver', run: () => stopReceiver() } : { label: 'Start receiver', run: () => startReceiver() },
      { label: 'Copy exporter settings (env)', hint: 'for apps not started here', run: () => { copyText(env); notify('Copied OTEL_* settings'); } },
      { label: `${o.autoStart ? '✓ ' : ''}Start with the app`, run: () => { o.autoStart = !o.autoStart; saveDB(); } },
    ], el);
  },
};
