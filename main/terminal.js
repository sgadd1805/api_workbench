'use strict';
// The Terminal panel: run a command in a chosen shell (bash / zsh / sh, or cmd / PowerShell on
// Windows) in the project's folder, streaming output back; send input to it; stop it. There is no
// pseudo-terminal, so full-screen/interactive programs (vim, top, password prompts) won't work —
// "Open external terminal" opens the system terminal in the same folder for those.
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WIN = process.platform === 'win32';
const procs = new Map(); // id → ChildProcess

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const onPath = (exe) => (process.env.PATH || '').split(path.delimiter).some((d) => exists(path.join(d, exe)));

// Shells available on this machine: [{ id, label }]; the first is the default.
function listShells() {
  if (WIN) {
    const shells = [{ id: 'cmd', label: 'Command Prompt (cmd)' }, { id: 'powershell', label: 'Windows PowerShell' }];
    if (onPath('pwsh.exe')) shells.push({ id: 'pwsh', label: 'PowerShell 7 (pwsh)' });
    const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find(exists);
    if (gitBash) shells.push({ id: 'gitbash', label: 'Git Bash', path: gitBash });
    return shells;
  }
  const user = path.basename(process.env.SHELL || '');
  const unix = ['zsh', 'bash', 'sh'].filter((s) => exists(`/bin/${s}`) || exists(`/usr/bin/${s}`));
  if (user && unix.includes(user)) unix.splice(unix.indexOf(user), 1), unix.unshift(user);
  return unix.map((s) => ({ id: s, label: s }));
}

// A command written for macOS / Linux, as cmd or PowerShell need it: ./mvnw and ./gradlew (shared task
// commands, api-client.json) run the Windows wrappers, and another leading ./program becomes .\program.
// Only the start of the line changes; anything else is left as written.
function forWindowsShell(shell, command) {
  const ps = shell === 'powershell' || shell === 'pwsh';
  return command.replace(/^(\s*)\.[\\/](mvnw|gradlew)(?=\s|$)/, (_m, lead, tool) => `${lead}${ps ? '.\\' : ''}${tool === 'mvnw' ? 'mvnw.cmd' : 'gradlew.bat'}`)
    .replace(/^(\s*)\.\/(?=[\w.-])/, '$1.\\');
}

// [executable, args, extra spawn options] for running one command line in a shell.
function shellCommand(shell, command) {
  if (shell === 'cmd' || shell === 'powershell' || shell === 'pwsh') command = forWindowsShell(shell, command);
  switch (shell) {
    case 'cmd': return ['cmd.exe', ['/d', '/s', '/c', `"${command}"`], { windowsVerbatimArguments: true }];
    case 'powershell': return ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {}];
    case 'pwsh': return ['pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {}];
    case 'gitbash': return [listShells().find((s) => s.id === 'gitbash')?.path || 'bash.exe', ['-lc', command], {}];
    default: {
      const exe = ['zsh', 'bash', 'sh'].includes(shell) ? (exists(`/bin/${shell}`) ? `/bin/${shell}` : `/usr/bin/${shell}`) : '/bin/sh';
      // -l: a login shell, so PATH from the user's profile (Homebrew, nvm, …) applies even when the app wasn't started from a terminal.
      return [exe, shell === 'sh' ? ['-c', command] : ['-lc', command], {}];
    }
  }
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p);

// A bare `cd <dir>` changes the panel's working folder instead of running (each command is its own process).
function resolveCd(cwd, command) {
  const m = /^\s*cd(?:\s+(?:\/d\s+)?(.+?))?\s*$/i.exec(command);
  if (!m) return null;
  const target = m[1] ? expandHome(m[1].replace(/^["']|["']$/g, '')) : os.homedir();
  const next = path.resolve(cwd, target);
  if (!exists(next) || !fs.statSync(next).isDirectory()) return { error: `cd: no such directory: ${target}` };
  return { cwd: next };
}

function run(sender, { id, shell, command, cwd, env = {} }) {
  const dir = cwd && exists(cwd) ? cwd : os.homedir();
  const cd = resolveCd(dir, command);
  if (cd) return cd.error ? { ok: false, error: cd.error } : { ok: true, cwd: cd.cwd, done: true };
  const [exe, args, extra] = shellCommand(shell, command);
  // Environment variables from the active environment are added (never replacing existing ones like PATH).
  const childEnv = { ...Object.fromEntries(Object.entries(env).filter(([k]) => /^[A-Za-z_]\w*$/.test(k))), ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' };
  let child;
  try {
    child = spawn(exe, args, { cwd: dir, env: childEnv, windowsHide: true, detached: !WIN, ...extra });
  } catch (err) { return { ok: false, error: err.message }; }
  procs.set(id, child);
  const send = (channel, payload) => { if (!sender.isDestroyed()) sender.send(channel, { id, ...payload }); };
  child.stdout.on('data', (d) => send('term-data', { stream: 'stdout', data: d.toString('utf8') }));
  child.stderr.on('data', (d) => send('term-data', { stream: 'stderr', data: d.toString('utf8') }));
  child.on('error', (err) => { send('term-data', { stream: 'stderr', data: `${exe}: ${err.message}\n` }); });
  child.on('close', (code, signal) => { procs.delete(id); send('term-exit', { code, signal }); });
  return { ok: true, cwd: dir, pid: child.pid };
}

// Stops the whole process tree (the shell and whatever it started).
function kill(id) {
  const child = procs.get(id); if (!child) return false;
  if (WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
  return true;
}

function openExternal(cwd) {
  const dir = cwd && exists(cwd) ? cwd : os.homedir();
  // The folder is passed as the working directory, never written into a command line.
  const child = WIN ? spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe'], { cwd: dir, detached: true, stdio: 'ignore' })
    : process.platform === 'darwin' ? spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' })
      : spawn('x-terminal-emulator', [], { cwd: dir, detached: true, stdio: 'ignore' });
  return new Promise((resolve) => {
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('spawn', () => { child.unref(); resolve({ ok: true }); });
  });
}

function register(ipcMain) {
  ipcMain.handle('term-shells', () => ({ shells: listShells(), home: os.homedir(), platform: process.platform }));
  ipcMain.handle('term-run', (e, opts) => run(e.sender, opts));
  ipcMain.handle('term-input', (_e, { id, text }) => { procs.get(id)?.stdin.write(text); return true; });
  ipcMain.handle('term-kill', (_e, id) => kill(id));
  ipcMain.handle('term-open-external', (_e, cwd) => openExternal(cwd));
}

module.exports = { listShells, shellCommand, forWindowsShell, resolveCd, register };
