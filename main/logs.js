'use strict';
// Log lines from running tasks (main/tasks.js) and from log sources (a file to tail, or a command such
// as `docker logs -f app` / `kubectl logs -f deploy/app`), kept in memory per source, streamed to the
// renderer, and searchable by a request's correlation id.
const { spawn } = require('child_process');
const fs = require('fs');
const { shellCommand } = require('./terminal');
const { broadcast } = require('./windows');

const MAX_LINES = 20000;
const LEVEL = /\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/;
// Lines that continue the previous entry: an exception header right after a log line
// ("java.lang.IllegalStateException: boom"), stack frames, "Caused by", "... 12 more", indented lines.
const CONTINUATION = /^(\s+at\s|\s*Caused by:|\s*\.\.\. \d+ more|\s*Suppressed:|\t|\s{4,}\S|[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)+(Exception|Error|Throwable)\b)/;

const sources = new Map(); // id → { id, name, lines: [{ n, at, text, level, cont }], next, listeners, proc?, watcher? }
const sendToRenderer = (channel, payload) => broadcast(channel, payload); // main window + popped-out log windows

function source(id, name = id) {
  if (!sources.has(id)) sources.set(id, { id, name, lines: [], next: 1, pending: [] });
  return sources.get(id);
}

// Split incoming text into lines (keeping a partial last line until its newline arrives).
function push(id, chunk, stream = 'stdout') {
  const src = source(id);
  const text = (src.partial || '') + chunk.toString('utf8').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const parts = text.split(/\r?\n/);
  src.partial = parts.pop();
  for (const line of parts) addLine(src, line, stream);
}

function addLine(src, text, stream) {
  const prev = src.lines[src.lines.length - 1];
  const cont = !!prev && CONTINUATION.test(text);
  const level = cont ? prev.level : (LEVEL.exec(text)?.[1].replace('WARNING', 'WARN') || (stream === 'stderr' ? 'STDERR' : ''));
  const line = { n: src.next++, at: Date.now(), text, level, cont };
  src.lines.push(line);
  if (src.lines.length > MAX_LINES) src.lines.splice(0, src.lines.length - MAX_LINES);
  src.pending.push(line);
  scheduleFlush();
}

// Batch lines to the renderer every 100 ms, so chatty logs don't flood IPC.
let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    for (const src of sources.values()) if (src.pending.length) { sendToRenderer('log-lines', { id: src.id, lines: src.pending }); src.pending = []; }
  }, 100);
}

function linesSince(id, after = 0, limit = 5000) {
  const src = sources.get(id); if (!src) return [];
  const from = src.lines.findIndex((l) => l.n > after);
  return from < 0 ? [] : src.lines.slice(from).slice(-limit);
}

// Lines containing any of the needles (e.g. request id, trace id), each with the continuation lines
// (stack trace) that follow it. → [{ source, name, lines }]
function findLines(ids, needles) {
  const want = needles.filter((x) => x && x.length >= 6);
  const out = [];
  for (const id of ids) {
    const src = sources.get(id); if (!src || !want.length) continue;
    const hits = [];
    for (let i = 0; i < src.lines.length; i++) {
      if (!want.some((w) => src.lines[i].text.includes(w))) continue;
      const block = [src.lines[i]];
      while (src.lines[i + 1]?.cont) block.push(src.lines[++i]);
      hits.push(...block);
    }
    if (hits.length) out.push({ source: id, name: src.name, lines: hits.slice(0, 500) });
  }
  return out;
}

// ---- log sources: tail a file, run a command, or follow a server (ssh / kubernetes / docker, see
// main/serverlogs.js) and read its output
function startSource(def) {
  const { id, name, type, path, command, shell, cwd } = def;
  stopSource(id);
  const src = source(id, name);
  src.name = name;
  if (type === 'ssh' || type === 'kubernetes' || type === 'docker') {
    let cmd;
    try { cmd = require('./serverlogs').tailCommand(def); } catch (err) { return { ok: false, error: err.message }; }
    push(id, `[${cmd.display}]\n`, 'stderr');
    return follow(id, src, spawn(cmd.exe, cmd.args, { env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' }, detached: process.platform !== 'win32', windowsHide: true }), cmd.exe);
  }
  if (type === 'file') {
    let size;
    try { size = fs.statSync(path).size; } catch { return { ok: false, error: `File not found: ${path}` }; }
    // Show the last 64 KB, then follow appends (and start over if the file is truncated / rotated).
    const readRange = (start, end) => {
      if (end <= start) return;
      const fd = fs.openSync(path, 'r'), buf = Buffer.alloc(end - start);
      try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
      push(id, buf);
    };
    readRange(Math.max(0, size - 65536), size);
    src.watcher = setInterval(() => {
      let st; try { st = fs.statSync(path); } catch { return; }
      if (st.size < size) size = 0;
      if (st.size > size) { readRange(size, st.size); size = st.size; }
    }, 500);
    return { ok: true };
  }
  const [exe, args, extra] = shellCommand(shell, command);
  return follow(id, src, spawn(exe, args, { cwd: cwd || undefined, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' }, detached: process.platform !== 'win32', windowsHide: true, ...extra }), exe);
}

function follow(id, src, proc, exe) {
  src.proc = proc;
  proc.stdout.on('data', (d) => push(id, d));
  proc.stderr.on('data', (d) => push(id, d, 'stderr'));
  proc.on('error', (err) => push(id, `[log source failed: ${err.code === 'ENOENT' ? `${exe} isn't installed or isn't on PATH` : err.message}]\n`, 'stderr'));
  proc.on('close', (code) => {
    if (src.proc !== proc) return;
    src.proc = null;
    push(id, `[log source exited: ${code}${exe === 'ssh' && code === 255 ? ' — ssh couldn\'t connect or log in. It uses your ssh keys / agent and ~/.ssh/config, without password prompts.' : ''}]\n`, 'stderr');
    sendToRenderer('log-source-state', { id, running: false });
  });
  return { ok: true };
}

function stopSource(id) {
  const src = sources.get(id); if (!src) return;
  if (src.watcher) { clearInterval(src.watcher); src.watcher = null; }
  if (src.proc) { killTree(src.proc); src.proc = null; }
}

function killTree(proc, signal = 'SIGTERM') {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-proc.pid, signal); } catch { try { proc.kill(signal); } catch {} } }
}

const clear = (id) => { const src = sources.get(id); if (src) { src.lines = []; src.pending = []; } };

function register(ipcMain) {
  ipcMain.handle('logs-lines', (_e, { id, after }) => linesSince(id, after));
  ipcMain.handle('logs-find', (_e, { ids, needles }) => findLines(ids, needles));
  ipcMain.handle('logs-source-start', (_e, def) => startSource(def));
  ipcMain.handle('logs-source-stop', (_e, id) => { stopSource(id); return true; });
  ipcMain.handle('logs-clear', (_e, id) => { clear(id); return true; });
  ipcMain.handle('logs-running', () => [...sources.values()].filter((s) => s.proc || s.watcher).map((s) => s.id));
}

module.exports = { push, addLine, source, linesSince, findLines, startSource, stopSource, killTree, clear, register, CONTINUATION };
