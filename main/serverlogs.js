'use strict';
// Server log sources (tail and search), next to the local file / command sources in main/logs.js:
//   ssh         files on a server, through the system `ssh` (your keys, agent and ~/.ssh/config;
//               BatchMode, so it never waits for a password)
//   kubernetes  `kubectl logs` for a deployment / pod / label selector
//   docker      `docker logs` for a container
//   file        files on this computer (search reads .gz rotations too)
// Commands are built as argument lists (no local shell). The one remote shell command (ssh) quotes
// every value, so source settings and search text can't inject commands.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');

// ---- quoting and validation
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Remote file arguments: globs (* ? [ ]) are allowed when the path has no other shell characters.
const GLOB_SAFE = /^[\w./*?[\]~@+,=-]+$/;
const remotePath = (p) => (GLOB_SAFE.test(p) && !p.startsWith('-') ? p : shq(p));
function checkArg(value, what) {
  if (value && (String(value).startsWith('-') || /[\0\n]/.test(value))) throw new Error(`${what} can't start with "-" or contain line breaks`);
  return value;
}
const pathsOf = (text) => String(text || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
const int = (v, min, max, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };

function sshArgs(ssh) {
  if (!ssh?.host) throw new Error('Enter the server\'s host (or an alias from ~/.ssh/config)');
  checkArg(ssh.host, 'Host'); checkArg(ssh.user, 'User');
  if (!/^[\w.:@%-]+$/.test(ssh.host) || (ssh.user && !/^[\w.@-]+$/.test(ssh.user))) throw new Error('Host / user contain characters ssh doesn\'t allow');
  return [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30',
    ...(ssh.port ? ['-p', String(int(ssh.port, 1, 65535, 22))] : []),
    ...(ssh.identityFile ? ['-i', checkArg(ssh.identityFile, 'Identity file')] : []),
    ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host,
  ];
}

function kubectlBase(k8s) {
  const k = k8s || {};
  for (const [v, what] of [[k.context, 'Context'], [k.namespace, 'Namespace'], [k.target, 'Target'], [k.selector, 'Selector'], [k.container, 'Container']]) checkArg(v, what);
  if (!k.target && !k.selector) throw new Error('Enter a target (deploy/name, pod/name) or a label selector');
  return {
    pre: [...(k.context ? ['--context', k.context] : []), ...(k.namespace ? ['-n', k.namespace] : [])],
    // A selector can match many pods: prefix each line with its pod.
    which: k.selector ? ['-l', k.selector, '--prefix', '--max-log-requests=20'] : [k.target],
    container: k.container ? ['-c', k.container] : k.selector ? ['--all-containers'] : [],
  };
}

// → { exe, args, display } to follow the source's newest lines.
function tailCommand(def, { lines = 200 } = {}) {
  const n = int(lines, 0, 100000, 200);
  if (def.type === 'ssh') {
    const files = pathsOf(def.ssh?.paths);
    if (!files.length) throw new Error('Enter the log file path(s) on the server');
    const remote = `tail -n ${n} -F ${files.map(remotePath).join(' ')}`;
    return { exe: 'ssh', args: [...sshArgs(def.ssh), remote], display: `ssh ${def.ssh.host} ${remote}` };
  }
  if (def.type === 'kubernetes') {
    const k = kubectlBase(def.k8s);
    const args = [...k.pre, 'logs', '-f', `--tail=${n}`, ...k.which, ...k.container];
    return { exe: 'kubectl', args, display: 'kubectl ' + args.join(' ') };
  }
  if (def.type === 'docker') {
    checkArg(def.docker?.container, 'Container');
    if (!def.docker?.container) throw new Error('Enter the container name or id');
    const args = ['logs', '-f', '--tail', String(n), def.docker.container];
    return { exe: 'docker', args, display: 'docker ' + args.join(' ') };
  }
  throw new Error(`No tail command for ${def.type} sources`);
}

// ---- search
// q: { pattern, regex, ignoreCase, context (lines around each hit), since ('1h' …, kubernetes / docker),
//      max (hits) }
function normalizeQuery(q) {
  const pattern = String(q.pattern || '');
  if (!pattern.trim()) throw new Error('Enter something to search for');
  const since = q.since && /^\d+[smhd]$/.test(q.since) ? q.since : '';
  return { pattern, regex: !!q.regex, ignoreCase: !!q.ignoreCase, context: int(q.context, 0, 20, 0), since, max: int(q.max, 1, 5000, 200) };
}

function matcher(q) {
  if (q.regex) {
    let re; try { re = new RegExp(q.pattern, q.ignoreCase ? 'i' : ''); } catch (err) { throw new Error('Bad regular expression: ' + err.message); }
    return (s) => re.test(s);
  }
  const needle = q.ignoreCase ? q.pattern.toLowerCase() : q.pattern;
  return q.ignoreCase ? (s) => s.toLowerCase().includes(needle) : (s) => s.includes(needle);
}

// Collects hits with context from a stream of lines. Hits: [{ file, line, text, before: [{ line, text }], after }]
class HitCollector {
  constructor(q) { this.q = q; this.test = matcher(q); this.hits = []; this.truncated = false; this.reset(); }
  reset() { this.ring = []; this.afterLeft = 0; this.last = null; }
  get full() { return this.hits.length >= this.q.max; }
  push(file, line, text) {
    if (this.test(text)) {
      if (this.full) { this.truncated = true; return false; }
      this.last = { file, line, text, before: this.ring.slice(), after: [] };
      this.hits.push(this.last);
      this.ring = []; this.afterLeft = this.q.context;
      return true;
    }
    if (this.afterLeft > 0 && this.last) { this.last.after.push({ line, text }); this.afterLeft--; return true; }
    if (this.q.context) { this.ring.push({ line, text }); if (this.ring.length > this.q.context) this.ring.shift(); }
    return !this.truncated;
  }
}

// `grep -n -C` output, each line prefixed "file<TAB>" by the remote loop: "12:match", "11-context", "--".
function parseGrep(out, q) {
  const hits = [];
  let truncated = false;
  let last = null, afterLeft = 0, pendingBefore = [];
  for (const raw of out.split('\n')) {
    if (!raw) continue;
    const tab = raw.indexOf('\t');
    if (tab < 0) continue;
    const file = raw.slice(0, tab), rest = raw.slice(tab + 1);
    if (rest === '--') { last = null; pendingBefore = []; continue; }
    const m = /^(\d+)([:-])(.*)$/s.exec(rest); if (!m) continue;
    const entry = { line: +m[1], text: m[3] };
    if (m[2] === ':') {
      if (hits.length >= q.max) { truncated = true; break; }
      last = { file, ...entry, before: pendingBefore.filter((b) => b.file === file).map(({ line, text }) => ({ line, text })), after: [] };
      hits.push(last); pendingBefore = []; afterLeft = q.context;
    } else if (last && last.file === file && afterLeft > 0) { last.after.push(entry); afterLeft--; } else pendingBefore.push({ file, ...entry });
  }
  return { hits, truncated };
}

function remoteGrepScript(files, q) {
  const opts = ['-n', q.ignoreCase ? '-i' : '', q.regex ? '-E' : '-F', q.context ? `-C ${q.context}` : '', `-m ${q.max}`].filter(Boolean).join(' ');
  // Each file (globs expanded by the remote shell); .gz rotations are decompressed; lines prefixed "file<TAB>".
  return `for f in ${files.map(remotePath).join(' ')}; do [ -f "$f" ] || continue; `
    + `case "$f" in *.gz) gzip -dc -- "$f" ;; *) cat -- "$f" ;; esac | LC_ALL=C grep ${opts} -e ${shq(q.pattern)} | awk -v f="$f" '{ print f "\\t" $0 }'; done`;
}

const running = new Map(); // search id → child process

function runProcess(id, exe, args, { onLine, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(exe, args, { windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }); } catch (err) { return resolve({ error: err.message }); }
    running.set(id, proc);
    let out = '', err = '', partial = '', stopped = false;
    const timer = setTimeout(() => { stopped = 'timeout'; proc.kill('SIGTERM'); }, timeoutMs);
    proc.stdout.on('data', (d) => {
      if (!onLine) { out += d; if (out.length > 50e6) { stopped = 'size'; proc.kill('SIGTERM'); } return; }
      const parts = (partial + d.toString('utf8')).split(/\r?\n/);
      partial = parts.pop();
      for (const l of parts) if (onLine(l) === false) { stopped = 'enough'; proc.kill('SIGTERM'); break; }
    });
    proc.stderr.on('data', (d) => { if (err.length < 8192) err += d; });
    proc.on('error', (e) => { clearTimeout(timer); running.delete(id); resolve({ error: e.code === 'ENOENT' ? `${exe} isn't installed or isn't on PATH` : e.message }); });
    proc.on('close', (code) => {
      clearTimeout(timer); running.delete(id);
      if (onLine && partial) onLine(partial);
      const cancelled = proc.cancelled;
      resolve({ out, code, stderr: err.trim(), stopped, cancelled });
    });
  });
}

// Local files: comma / newline separated paths, a "*" glob allowed in the file name part.
function expandLocal(spec) {
  const files = [];
  for (const p of pathsOf(spec)) {
    const dir = path.dirname(p), base = path.basename(p);
    if (!/[*?]/.test(base)) { if (fs.existsSync(p)) files.push(p); continue; }
    const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    try { for (const f of fs.readdirSync(dir).sort()) if (re.test(f)) files.push(path.join(dir, f)); } catch { /* missing folder */ }
  }
  return files;
}

async function searchLocal(files, q) {
  const c = new HitCollector(q);
  for (const file of files) {
    c.reset();
    const raw = fs.createReadStream(file);
    const input = file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let n = 0;
    try { for await (const line of rl) { if (c.push(file, ++n, line) === false) break; } } catch (err) { return { hits: c.hits, truncated: c.truncated, error: `${file}: ${err.message}` }; } finally { rl.close(); raw.destroy(); }
    if (c.truncated) break;
  }
  return { hits: c.hits, truncated: c.truncated };
}

// Search one source. → { hits, truncated, command (what ran, for display), error?, ms }
async function search(id, def, query) {
  const q = normalizeQuery(query);
  const t0 = Date.now();
  const done = (r, command) => ({ hits: [], truncated: false, ...r, command, ms: Date.now() - t0 });
  if (def.type === 'ssh') {
    const files = pathsOf(def.ssh?.paths);
    if (!files.length) throw new Error('Enter the log file path(s) on the server');
    const script = remoteGrepScript(files, q);
    const res = await runProcess(id, 'ssh', [...sshArgs(def.ssh), script]);
    if (res.error) return done({ error: res.error }, `ssh ${def.ssh.host} …`);
    if (res.cancelled) return done({ error: 'Cancelled' }, '');
    // grep exits 1 for "no match"; ssh failures are 255.
    if (res.code === 255 || (res.code > 1 && !res.out)) return done({ error: res.stderr || `ssh exited with ${res.code}` }, `ssh ${def.ssh.host}`);
    return done({ ...parseGrep(res.out, q), ...(res.stopped === 'timeout' && { error: 'Timed out after 2 minutes; partial results' }) }, `ssh ${def.ssh.host}: grep in ${files.join(', ')}`);
  }
  if (def.type === 'kubernetes' || def.type === 'docker') {
    let exe, args;
    if (def.type === 'kubernetes') { const k = kubectlBase(def.k8s); exe = 'kubectl'; args = [...k.pre, 'logs', ...(q.since ? [`--since=${q.since}`] : ['--tail=100000']), ...k.which, ...k.container]; }
    else { checkArg(def.docker?.container, 'Container'); exe = 'docker'; args = ['logs', ...(q.since ? ['--since', q.since] : ['--tail', '100000']), def.docker?.container || '']; }
    const c = new HitCollector(q);
    let n = 0;
    // A selector's lines start with "[pod/name/container] ": use that as the "file".
    const res = await runProcess(id, exe, args, { onLine: (l) => {
      const m = def.type === 'kubernetes' && def.k8s?.selector ? /^\[([^\]]+)\] (.*)$/s.exec(l) : null;
      return c.push(m ? m[1] : def.type === 'docker' ? def.docker.container : def.k8s.target, ++n, m ? m[2] : l);
    } });
    if (res.error) return done({ error: res.error }, `${exe} ${args.join(' ')}`);
    if (res.code && !c.hits.length && !res.stopped) return done({ error: res.stderr || `${exe} exited with ${res.code}` }, `${exe} ${args.join(' ')}`);
    return done({ hits: c.hits, truncated: c.truncated }, `${exe} ${args.join(' ')}`);
  }
  if (def.type === 'file') {
    const files = expandLocal(def.path);
    if (!files.length) return done({ error: `No files match ${def.path}` }, '');
    const r = await searchLocal(files, q);
    return done(r, `search in ${files.length} file(s)`);
  }
  throw new Error('This source can\'t be searched on its own (a command source): use the live view\'s filter');
}

function cancel(id) { const p = running.get(id); if (p) { p.cancelled = true; p.kill('SIGTERM'); } return !!p; }

function register(ipcMain) {
  ipcMain.handle('logs-search', async (_e, { searchId, def, query }) => {
    try { return { ok: true, ...(await search(searchId, def, query)) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('logs-search-cancel', (_e, searchId) => cancel(searchId));
}

module.exports = { tailCommand, search, parseGrep, remoteGrepScript, sshArgs, HitCollector, expandLocal, normalizeQuery, shq, register };
