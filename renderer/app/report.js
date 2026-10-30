// Bug report bundle for one exchange: request, response, checks, timing, matching server logs, trace
// and a cURL to reproduce, as Markdown (for a ticket) or a standalone HTML page.
// Credentials are redacted unless asked otherwise: auth / cookie / API-key headers, and bearer / basic
// values and secret-looking query parameters in the URL and the cURL.
import { esc } from '../shared/html.js';
import { prettyJson, isJson } from '../shared/json.js';
import { toCurl } from './curl.js';

const MAX_BODY = 20000;
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token|x-amz-security-token)$/i;
const SENSITIVE_PARAM = /^(access_token|id_token|refresh_token|token|api_key|apikey|key|password|passwd|secret|client_secret|signature|sig)$/i;
const REDACTED = '<redacted>';

export function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (SENSITIVE_PARAM.test(k)) u.searchParams.set(k, REDACTED);
    if (u.password) u.password = 'redacted';
    return u.toString().replace(/%3Credacted%3E/gi, REDACTED);
  } catch { return url; }
}
export const redactHeaders = (h = {}) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SENSITIVE_HEADER.test(k) ? REDACTED : v]));

const clip = (text, n = MAX_BODY) => (text.length > n ? { text: text.slice(0, n), cut: text.length - n } : { text, cut: 0 });
const bodyText = (b) => (isJson(b) ? prettyJson(b) : b || '');
const ms = (n) => (n == null ? '' : `${Math.round(n * 10) / 10} ms`);

// ctx: { loc, res, envName, logs: [{ name, lines: [{ text }] }] (correlated lines), spans (main/otel.js), redact = true }
export function buildReport({ loc, res, envName = '', logs = [], spans = [], redact = true }) {
  const req = res.requestData || {};
  const R = redact ? { url: redactUrl, headers: redactHeaders } : { url: (u) => u, headers: (h) => h };
  const url = R.url(req.url || loc.r.url);
  let path = url; try { const u = new URL(url); path = u.pathname; } catch { /* keep */ }
  const checks = [];
  for (const a of res.assertionResults || []) checks.push({ ok: a.ok, text: `assertion \`${a.expr}\`${a.err ? ` (${a.err})` : ''}` });
  for (const t of res.scriptTests || []) checks.push({ ok: t.ok, text: `test "${t.name}"${t.error ? ` — ${t.error}` : ''}` });
  for (const i of [...(res.validation?.request || []), ...(res.validation?.response || [])]) checks.push({ ok: i.level !== 'error', text: `spec: \`${i.where}\` ${i.message}` });
  if (res.snapshotResult) checks.push({ ok: res.snapshotResult.matches, text: res.snapshotResult.matches ? 'matches the saved snapshot' : `${res.snapshotResult.diffs.length} difference(s) from the snapshot: ${res.snapshotResult.diffs.slice(0, 5).map((d) => `\`${d.path}\` ${d.expected} → ${d.actual}`).join('; ')}` });
  for (const w of res.warnings || []) checks.push({ ok: false, warn: true, text: w });
  const t = res.timing || {};
  const timing = [['DNS', t.dns], ['TCP connect', t.tcp], ['TLS', t.tls], ['Request sent', t.request], ['Waiting (TTFB)', t.wait], ['Download', t.download]].filter(([, v]) => v != null);
  let curl = '';
  try { curl = toCurl({ ...req, url, headers: R.headers(req.headers || {}) }); } catch { /* no request data */ }
  const reqBody = clip(bodyText(req.body || ''));
  const resBody = clip(res.error ? '' : res.binary ? `(binary, ${res.size} bytes)` : bodyText(res.body || ''));
  return {
    title: `${req.method || loc.r.method} ${path} → ${res.error ? 'error' : `${res.status} ${res.statusText || ''}`.trim()}`,
    meta: [['Request', loc.r.name], ['Project', loc.p.name], ['Environment', envName || '—'], ['When', new Date().toLocaleString()], ['Duration', res.time != null ? `${res.time} ms` : '—'],
      ...(res.correlation ? [['X-Request-Id', res.correlation.requestId], ['Trace id', res.correlation.traceId]] : []), ...(res.traceLink ? [['Trace', res.traceLink]] : [])],
    request: { line: `${req.method || loc.r.method} ${url}`, headers: R.headers(req.headers || {}), body: reqBody },
    response: res.error ? { error: res.error } : { line: `HTTP ${res.status} ${res.statusText || ''}`.trim(), headers: R.headers(res.headers || {}), body: resBody, lang: isJson(res.body) ? 'json' : '' },
    checks, timing,
    logs: logs.filter((g) => g.lines?.length).map((g) => ({ name: g.name, lines: g.lines.slice(0, 200).map((l) => l.text) })),
    spans: [...spans].sort((a, b) => a.start - b.start).slice(0, 40).map((s) => ({ service: s.service, name: s.name, ms: s.ms, error: s.status?.code === 'error' ? s.status.message || 'error' : '' })),
    curl,
  };
}

const fence = (text, lang = '') => { const f = /```/.test(text) ? '~~~~' : '```'; return `${f}${lang}\n${text}\n${f}`; };
const headerLines = (h) => Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n');

export function toMarkdown(r) {
  const out = [`## ${r.title}`, '', r.meta.map(([k, v]) => `**${k}:** ${v}`).join('  \n')];
  out.push('', '### Request', fence(`${r.request.line}\n${headerLines(r.request.headers)}${r.request.body.text ? `\n\n${r.request.body.text}` : ''}`, 'http'));
  if (r.request.body.cut) out.push(`_(request body truncated: ${r.request.body.cut} more characters)_`);
  if (r.response.error) out.push('', '### Error', fence(r.response.error));
  else {
    out.push('', '### Response', fence(`${r.response.line}\n${headerLines(r.response.headers)}`, 'http'));
    if (r.response.body.text) out.push(fence(r.response.body.text, r.response.lang));
    if (r.response.body.cut) out.push(`_(response body truncated: ${r.response.body.cut} more characters)_`);
  }
  if (r.checks.length) out.push('', '### Checks', ...r.checks.map((c) => `- ${c.warn ? '⚠' : c.ok ? '✅' : '❌'} ${c.text}`));
  if (r.timing.length) out.push('', '### Timing', '| Phase | Time |', '|---|---|', ...r.timing.map(([k, v]) => `| ${k} | ${ms(v)} |`));
  if (r.spans?.length) out.push('', '### Trace', '| Service | Span | Time | |', '|---|---|---|---|', ...r.spans.map((s) => `| ${s.service} | ${s.name.replace(/\|/g, '\\|')} | ${ms(s.ms)} | ${s.error ? `❌ ${s.error.replace(/\|/g, '\\|')}` : ''} |`));
  for (const g of r.logs) out.push('', `### Server log: ${g.name}`, fence(g.lines.join('\n')));
  if (r.curl) out.push('', '### Reproduce', fence(r.curl, 'bash'));
  return out.join('\n') + '\n';
}

export function toHtml(r) {
  const pre = (text, cls = '') => `<pre class="${cls}">${esc(text)}</pre>`;
  const body = [`<h1>${esc(r.title)}</h1>`, `<table class="meta">${r.meta.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${/^https?:\/\//.test(v) ? `<a href="${esc(v)}">${esc(v)}</a>` : esc(v)}</td></tr>`).join('')}</table>`,
    '<h2>Request</h2>', pre(`${r.request.line}\n${headerLines(r.request.headers)}${r.request.body.text ? `\n\n${r.request.body.text}` : ''}`)];
  if (r.response.error) body.push('<h2>Error</h2>', pre(r.response.error, 'bad'));
  else body.push('<h2>Response</h2>', pre(`${r.response.line}\n${headerLines(r.response.headers)}`), r.response.body.text ? pre(r.response.body.text) : '');
  if (r.checks.length) body.push('<h2>Checks</h2><ul>', ...r.checks.map((c) => `<li class="${c.warn ? 'warn' : c.ok ? 'ok' : 'bad'}">${c.warn ? '⚠' : c.ok ? '✓' : '✗'} ${esc(c.text.replace(/`/g, ''))}</li>`), '</ul>');
  if (r.timing.length) body.push('<h2>Timing</h2><table>', ...r.timing.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(ms(v))}</td></tr>`), '</table>');
  if (r.spans?.length) body.push('<h2>Trace</h2><table>', ...r.spans.map((s) => `<tr><td>${esc(s.service)}</td><td>${esc(s.name)}</td><td>${esc(ms(s.ms))}</td><td class="bad">${esc(s.error)}</td></tr>`), '</table>');
  for (const g of r.logs) body.push(`<h2>Server log: ${esc(g.name)}</h2>`, pre(g.lines.join('\n'), 'log'));
  if (r.curl) body.push('<h2>Reproduce</h2>', pre(r.curl));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(r.title)}</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#1f2328;background:#fff}
h1{font-size:20px}h2{font-size:16px;margin-top:24px;border-bottom:1px solid #d5d9e0;padding-bottom:4px}pre{background:#f6f7f9;border:1px solid #d5d9e0;border-radius:6px;padding:10px;overflow:auto;font:12px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
table{border-collapse:collapse}th,td{text-align:left;padding:2px 12px 2px 0;vertical-align:top}th{color:#5b6573;font-weight:600}.ok{color:#1a7f37}.bad{color:#cf222e}.warn{color:#9a6700}ul{padding-left:18px}</style></head>
<body>${body.join('\n')}</body></html>\n`;
}
