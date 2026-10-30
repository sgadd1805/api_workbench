'use strict';
// Task runner: start / stop / restart local services under test (Spring Boot via Maven or Gradle,
// a built jar, or any command), with JDK, profile, JVM options and env vars; detect when they're
// ready (a log line, or a health URL answering); their output goes to main/logs.js.
//
// Task (renderer): { id, name, command, cwd, javaHome, profile, jvmOpts, env: [Row], readyLog, readyUrl }
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const logs = require('./logs');
const { shellCommand, listShells } = require('./terminal');
const { broadcast } = require('./windows');

const DEFAULT_READY_LOG = 'Started \\S+ in [\\d.]+ seconds|Tomcat started on port|Netty started on port|Jetty started on port';
const running = new Map(); // task id → { proc, state, startedAt, readyAt, port, def, readyTimer }

const notify = (payload) => broadcast('task-state', payload);
const stateOf = (id) => {
  const t = running.get(id);
  return t ? { id, state: t.state, pid: t.proc?.pid, startedAt: t.startedAt, readyAt: t.readyAt, port: t.port, exitCode: t.exitCode } : { id, state: 'stopped' };
};
function setState(id, state, extra = {}) {
  const t = running.get(id); if (!t) return;
  Object.assign(t, { state }, extra);
  if (state === 'ready') t.readyAt = Date.now();
  notify(stateOf(id));
}

// Suggest commands from what's in the folder: Maven / Gradle wrappers or builds, built jars.
function detect(folder) {
  const has = (f) => fs.existsSync(path.join(folder, f));
  const win = process.platform === 'win32';
  const out = [];
  if (has('mvnw') || has('mvnw.cmd')) out.push({ name: 'Spring Boot (Maven wrapper)', command: win ? 'mvnw.cmd spring-boot:run' : './mvnw spring-boot:run' });
  else if (has('pom.xml')) out.push({ name: 'Spring Boot (Maven)', command: 'mvn spring-boot:run' });
  if (has('gradlew') || has('gradlew.bat')) out.push({ name: 'Spring Boot (Gradle wrapper)', command: win ? 'gradlew.bat bootRun' : './gradlew bootRun' });
  else if (has('build.gradle') || has('build.gradle.kts')) out.push({ name: 'Spring Boot (Gradle)', command: 'gradle bootRun' });
  for (const dir of ['target', 'build/libs']) {
    let jars = [];
    try { jars = fs.readdirSync(path.join(folder, dir)).filter((f) => f.endsWith('.jar') && !/-(plain|sources|javadoc)\.jar$/.test(f)); } catch {}
    for (const jar of jars) out.push({ name: `Run ${jar}`, command: `java -jar ${path.join(dir, jar)}` });
  }
  return out;
}

// Environment for the child: JAVA_HOME (and its bin first on PATH), Spring profile, JVM options
// (JAVA_TOOL_OPTIONS is read by every JVM, whether started by java, Maven or Gradle), extra vars.
function childEnv(def) {
  const env = { ...process.env, TERM: 'dumb', NO_COLOR: '1' };
  if (def.javaHome) { env.JAVA_HOME = def.javaHome; env.PATH = path.join(def.javaHome, 'bin') + path.delimiter + (env.PATH || ''); }
  if (def.profile) env.SPRING_PROFILES_ACTIVE = def.profile;
  if (def.jvmOpts) env.JAVA_TOOL_OPTIONS = [env.JAVA_TOOL_OPTIONS, def.jvmOpts].filter(Boolean).join(' ');
  for (const r of def.env || []) if (r.on && r.k) env[r.k] = r.v;
  return env;
}

const PORT_LOG = /(?:Tomcat|Netty|Jetty|Undertow)[^\n]*?started on port[s]?[^\d]*(\d{2,5})|port\(s\)?:?\s*(\d{2,5})/i;

function start(def) {
  if (running.get(def.id)?.proc) return { ok: false, error: `${def.name} is already running` };
  const cwd = def.cwd || os.homedir();
  if (!fs.existsSync(cwd)) return { ok: false, error: `Folder not found: ${cwd}` };
  const shell = def.shell || listShells()[0]?.id;
  const [exe, args, extra] = shellCommand(shell, def.command);
  logs.source(def.id, def.name);
  logs.addLine(logs.source(def.id), `▶ ${def.command}   (in ${cwd}${def.profile ? `, profile ${def.profile}` : ''})`, 'system');
  let proc;
  try { proc = spawn(exe, args, { cwd, env: childEnv(def), detached: process.platform !== 'win32', windowsHide: true, ...extra }); }
  catch (err) { return { ok: false, error: err.message }; }
  const t = { proc, state: 'starting', startedAt: Date.now(), readyAt: null, port: null, exitCode: null, def };
  running.set(def.id, t);
  let readyRe = null;
  try { readyRe = new RegExp(def.readyLog || DEFAULT_READY_LOG); } catch {}
  const onData = (stream) => (d) => {
    logs.push(def.id, d, stream);
    const text = d.toString();
    if (!t.port) { const m = PORT_LOG.exec(text); if (m) t.port = Number(m[1] || m[2]); }
    if (t.state === 'starting' && readyRe?.test(text)) setState(def.id, 'ready');
  };
  proc.stdout.on('data', onData('stdout'));
  proc.stderr.on('data', onData('stderr'));
  proc.on('error', (err) => { logs.push(def.id, `[failed to start: ${err.message}]\n`, 'stderr'); setState(def.id, 'failed'); });
  proc.on('close', (code, signal) => {
    clearInterval(t.readyTimer);
    if (running.get(def.id) !== t) return;
    t.proc = null;
    logs.addLine(logs.source(def.id), `■ exited ${signal ? `(${signal})` : `with code ${code}`}`, 'system');
    setState(def.id, t.stopping || code === 0 ? 'stopped' : 'failed', { exitCode: code });
  });
  // Health URL: poll until it answers (any status below 500).
  if (def.readyUrl) {
    t.readyTimer = setInterval(async () => {
      if (t.state !== 'starting') return clearInterval(t.readyTimer);
      try {
        const res = await fetch(def.readyUrl, { signal: AbortSignal.timeout(1500) });
        if (res.status < 500) { clearInterval(t.readyTimer); setState(def.id, 'ready'); }
      } catch {}
    }, 1000);
  }
  notify(stateOf(def.id));
  return { ok: true, ...stateOf(def.id) };
}

// SIGTERM the process tree (Spring shuts down gracefully), SIGKILL after 10 s if it's still there.
function stop(id) {
  const t = running.get(id);
  if (!t?.proc) return { ok: true, ...stateOf(id) };
  t.stopping = true;
  setState(id, 'stopping');
  const proc = t.proc;
  logs.killTree(proc, 'SIGTERM');
  setTimeout(() => { if (t.proc === proc) logs.killTree(proc, 'SIGKILL'); }, 10000);
  return { ok: true, ...stateOf(id) };
}

function waitStopped(id, ms = 15000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (!running.get(id)?.proc || Date.now() - t0 > ms ? resolve() : setTimeout(tick, 100));
    tick();
  });
}

async function restart(def) { stop(def.id); await waitStopped(def.id); return start(def); }

function stopAll() { for (const id of running.keys()) stop(id); }

function register(ipcMain) {
  ipcMain.handle('task-detect', (_e, folder) => (folder && fs.existsSync(folder) ? detect(folder) : []));
  ipcMain.handle('task-start', (_e, def) => start(def));
  ipcMain.handle('task-stop', (_e, id) => stop(id));
  ipcMain.handle('task-restart', (_e, def) => restart(def));
  ipcMain.handle('task-states', () => [...running.keys()].map(stateOf));
  // Don't leave servers running after the app quits.
  require('electron').app.on('before-quit', stopAll);
}

module.exports = { detect, childEnv, start, stop, restart, stateOf, DEFAULT_READY_LOG, register };
