'use strict';
// Records the login window's XHR/Fetch traffic (with response bodies) as HAR entries, via the
// Chrome DevTools Protocol, and serves the Capture toolbar's count / download / clear actions.
const { dialog } = require('electron');
const fs = require('fs');

const harHeaders = (h) => Object.entries(h || {}).map(([name, value]) => ({ name, value: String(value) }));
const headerValue = (h, name) => Object.entries(h || {}).find(([k]) => k.toLowerCase() === name)?.[1];

function harResponse(r) {
  return {
    status: r.status,
    statusText: r.statusText,
    httpVersion: 'HTTP/1.1',
    headers: harHeaders(r.headers),
    content: { size: 0, mimeType: r.mimeType || headerValue(r.headers, 'content-type') || '' },
    redirectURL: '',
    headersSize: -1,
    bodySize: -1,
  };
}

function harRequestEntry(params) {
  const { request } = params;
  return {
    startedDateTime: new Date(params.wallTime * 1000).toISOString(),
    time: 0,
    request: {
      method: request.method,
      url: request.url,
      httpVersion: 'HTTP/1.1',
      headers: harHeaders(request.headers),
      queryString: [],
      postData: request.postData
        ? { mimeType: headerValue(request.headers, 'content-type') || 'application/octet-stream', text: request.postData }
        : undefined,
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    _startTime: params.timestamp,
  };
}

// Turns CDP Network.* events into finished HAR entries. getBody(requestId) → Promise<{body, base64Encoded}>.
class HarRecorder {
  constructor(getBody) {
    this.getBody = getBody;
    this.entries = [];
    this.pending = new Map();
  }

  clear() { this.entries = []; this.pending.clear(); }

  finish(requestId, entry, timestamp) {
    entry.time = Math.round((timestamp - entry._startTime) * 1000);
    delete entry._startTime;
    this.entries.push(entry);
    this.pending.delete(requestId);
  }

  handle(method, params) {
    const entry = this.pending.get(params.requestId);
    switch (method) {
      case 'Network.requestWillBeSent':
        // A redirect reuses the requestId: finish the hop that redirected before tracking the next one.
        if (entry && params.redirectResponse) {
          entry.response = harResponse(params.redirectResponse);
          entry.response.redirectURL = params.request.url;
          this.finish(params.requestId, entry, params.timestamp);
        }
        if (params.type === 'XHR' || params.type === 'Fetch') this.pending.set(params.requestId, harRequestEntry(params));
        break;
      case 'Network.responseReceived':
        if (entry) entry.response = harResponse(params.response);
        break;
      case 'Network.loadingFailed':
        // Failed/blocked/cancelled requests: keep them (status 0) instead of leaking them in `pending`.
        if (!entry) break;
        entry.response = entry.response || harResponse({ status: 0, statusText: params.errorText || 'failed' });
        entry.response._error = params.errorText;
        this.finish(params.requestId, entry, params.timestamp);
        break;
      case 'Network.loadingFinished':
        if (!entry || !entry.response) break;
        return this.getBody(params.requestId)
          .then((result) => {
            entry.response.content.text = result.body;
            if (result.base64Encoded) entry.response.content.encoding = 'base64';
            entry.response.content.size = result.body.length;
          })
          .catch(() => {})
          .finally(() => this.finish(params.requestId, entry, params.timestamp));
    }
  }
}

const TOKEN_FIELDS = ['access_token', 'accessToken', 'id_token', 'idToken', 'token', 'jwt'];

// Most recent bearer token seen in the capture: an Authorization header the page sent, else a
// token field in a JSON response (top level or under `data`). → { token, source } | null
function findBearerToken(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const auth = e.request.headers.find((h) => h.name.toLowerCase() === 'authorization')?.value;
    const m = auth && /^Bearer\s+(\S+)/i.exec(auth);
    if (m) return { token: m[1], source: `Authorization header of ${e.request.method} ${e.request.url}` };
    const text = e.response?.content?.encoding ? null : e.response?.content?.text;
    if (!text) continue;
    try {
      const json = JSON.parse(text);
      for (const obj of [json, json?.data]) {
        const field = obj && typeof obj === 'object' && TOKEN_FIELDS.find((f) => typeof obj[f] === 'string' && obj[f]);
        if (field) return { token: obj[field], source: `"${field}" in the response of ${e.request.method} ${e.request.url}` };
      }
    } catch {}
  }
  return null;
}

// The parts of each entry the renderer needs to list captured traffic (the Session toolbar's Network
// list) and turn it into saved requests.
const entrySummaries = (entries) => entries.map((e, index) => ({
  index,
  method: e.request.method,
  url: e.request.url,
  status: e.response?.status ?? 0,
  statusText: e.response?.statusText ?? '',
  error: e.response?._error || '',
  headers: e.request.headers,
  postData: e.request.postData?.text ?? '',
  mimeType: e.request.postData?.mimeType ?? '',
  responseType: e.response?.content?.mimeType ?? '',
  size: e.response?.content?.size ?? 0,
  time: e.time ?? 0,
  at: e.startedDateTime || '',
}));

const TEXT_TYPE = /^text\/|json|xml|javascript|html|x-www-form-urlencoded|graphql/i;
// One entry in full, for opening it in the app: its request and the response the page got, shaped like a
// send() result (headers as an object; a text body decoded; a binary one left as base64). → object | null
function entryDetail(e) {
  if (!e) return null;
  const obj = (list) => Object.fromEntries((list || []).map((h) => [h.name, h.value]));
  const c = e.response?.content || {};
  const base64 = c.encoding === 'base64';
  const text = !base64 ? c.text ?? '' : TEXT_TYPE.test(c.mimeType || '') ? Buffer.from(c.text || '', 'base64').toString('utf8') : '';
  return {
    request: { method: e.request.method, url: e.request.url, headers: obj(e.request.headers), body: e.request.postData?.text ?? '' },
    response: {
      status: e.response?.status ?? 0, statusText: e.response?.statusText ?? '', headers: obj(e.response?.headers),
      body: text, ...(base64 && !text && { binary: true, bodyBase64: c.text || '', size: Buffer.from(c.text || '', 'base64').length }), mimeType: c.mimeType || '', time: e.time ?? 0, error: e.response?._error || '',
    },
  };
}

// A HAR file saved from a browser's DevTools (Chrome, Edge, Firefox, Safari) → entries for the Network list.
// API calls are kept: Chrome / Edge mark each entry's _resourceType, and documents, scripts, styles, images,
// fonts and media are skipped; files without that mark keep every entry. → { entries, skipped }
const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'manifest', 'texttrack', 'ping', 'cspviolationreport', 'preflight', 'other', 'document']);
function harFromFile(text) {
  let har;
  try { har = JSON.parse(text); } catch { throw new Error('Not a HAR file: it isn\'t JSON'); }
  const list = har?.log?.entries;
  if (!Array.isArray(list)) throw new Error('Not a HAR file: no log.entries');
  const entries = [];
  let skipped = 0;
  for (const e of list) {
    if (!e?.request?.method || !e.request.url || /^(data|blob|chrome-extension):/i.test(e.request.url)) { skipped++; continue; }
    if (e._resourceType && STATIC_TYPES.has(String(e._resourceType).toLowerCase())) { skipped++; continue; }
    const r = e.response || {}, c = r.content || {};
    entries.push({
      startedDateTime: e.startedDateTime || new Date().toISOString(),
      time: Math.round(e.time || 0),
      request: { method: e.request.method, url: e.request.url, headers: (e.request.headers || []).filter((h) => h?.name && !h.name.startsWith(':')), postData: e.request.postData?.text != null ? { mimeType: e.request.postData.mimeType || '', text: e.request.postData.text } : undefined },
      response: { status: r.status || 0, statusText: r.statusText || '', headers: r.headers || [], content: { size: c.size ?? (c.text ? c.text.length : 0), mimeType: c.mimeType || '', ...(c.text != null && { text: c.text }), ...(c.encoding && { encoding: c.encoding }) }, ...(r._error && { _error: r._error }) },
      _imported: true,
    });
  }
  return { entries, skipped };
}

const recorder = new HarRecorder(() => Promise.reject(new Error('no window attached')));

function attachNetworkCapture(win) {
  const dbg = win.webContents.debugger;
  try { dbg.attach('1.3'); } catch { return; }
  dbg.sendCommand('Network.enable').catch(() => {});
  recorder.getBody = (requestId) => dbg.sendCommand('Network.getResponseBody', { requestId });
  dbg.on('message', (_event, method, params) => recorder.handle(method, params));
}

function register(ipcMain) {
  ipcMain.handle('har-count', () => recorder.entries.length);
  ipcMain.handle('har-entries', () => entrySummaries(recorder.entries));
  ipcMain.handle('har-entry', (_e, index) => entryDetail(recorder.entries[index]));
  ipcMain.handle('download-har', async () => {
    const har = { log: { version: '1.2', creator: { name: 'API Workbench', version: '1.0.0' }, entries: recorder.entries } };
    const { filePath, canceled } = await dialog.showSaveDialog({
      defaultPath: `capture-${Date.now()}.har`,
      filters: [{ name: 'HAR files', extensions: ['har'] }],
    });
    if (canceled || !filePath) return { ok: false };
    fs.writeFileSync(filePath, JSON.stringify(har, null, 2));
    return { ok: true, filePath };
  });
  ipcMain.handle('clear-har', () => { recorder.clear(); return true; });
  // Adds a HAR file's API calls to the capture (after anything captured already). → { ok, added, skipped, filePath }
  ipcMain.handle('har-import', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'HAR files', extensions: ['har', 'json'] }, { name: 'All files', extensions: ['*'] }] });
    if (canceled || !filePaths[0]) return { ok: false, canceled: true };
    try {
      if (fs.statSync(filePaths[0]).size > 200 * 1024 * 1024) return { ok: false, error: 'The HAR file is larger than 200 MB' };
      const { entries, skipped } = harFromFile(fs.readFileSync(filePaths[0], 'utf8'));
      recorder.entries.push(...entries);
      return { ok: true, added: entries.length, skipped, filePath: filePaths[0] };
    } catch (err) { return { ok: false, error: err.message }; }
  });
}

module.exports = { HarRecorder, recorder, attachNetworkCapture, findBearerToken, entrySummaries, entryDetail, harFromFile, register };
