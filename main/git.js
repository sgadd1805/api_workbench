'use strict';
// Git history for a request: find where its endpoint is defined in the project's code (git grep for
// the path template / operationId), then list commits that touched those files or added/removed
// the path string itself (git log -S), and show any commit's diff.
const { execFile } = require('child_process');
const path = require('path');

const FIELD = '\x1f', RECORD = '\x1e';
const LOG_FORMAT = `--format=${RECORD}%H${FIELD}%h${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%s`;

function git(cwd, args, { maxBuffer = 32 * 1024 * 1024, timeout = 30000, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer, timeout, windowsHide: true }, (err, stdout, stderr) => {
      const code = err?.code;
      if (err && code === 'ENOENT') return reject(new Error('git is not installed or not on PATH'));
      if (err && !okCodes.includes(code)) return reject(new Error((stderr || err.message).trim().split('\n')[0]));
      resolve(stdout);
    });
  });
}

async function repoInfo(folder) {
  const top = (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
  const branch = (await git(top, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  return { top, branch };
}

// `git log … --name-only` output → [{ hash, short, author, email, date, subject, files }]
function parseLog(out) {
  return out.split(RECORD).filter((s) => s.trim()).map((rec) => {
    const [header, ...rest] = rec.split('\n');
    const [hash, short, author, email, date, subject] = header.split(FIELD);
    return { hash, short, author, email, date, subject, files: rest.map((l) => l.trim()).filter(Boolean) };
  });
}

// git grep -z -n: "file\0line\0text" per match.
function parseGrep(out) {
  return out.split('\n').filter(Boolean).map((l) => {
    const [file, line, ...text] = l.split('\0');
    return { file, line: Number(line), text: text.join('\0').trim().slice(0, 200) };
  });
}

const MAX_HITS_PER_TERM = 200, MAX_FILES = 40;

async function requestHistory({ folder, terms, extraFiles = [] }) {
  const { top, branch } = await repoInfo(folder);
  const files = new Map(); // repo-relative path → [{ term, line, text }]
  for (const term of terms.filter((t) => t && t.length >= 3)) {
    // exit code 1 = no matches
    const out = await git(top, ['grep', '-z', '-n', '-I', '-F', '--max-count=5', '-e', term], { okCodes: [0, 1] });
    for (const hit of parseGrep(out).slice(0, MAX_HITS_PER_TERM)) {
      if (!files.has(hit.file)) files.set(hit.file, []);
      files.get(hit.file).push({ term, line: hit.line, text: hit.text });
    }
  }
  for (const f of extraFiles) {
    const rel = path.relative(top, f).split(path.sep).join('/'); // git's form, also on Windows
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && !files.has(rel)) files.set(rel, [{ term: '(API spec)', line: 0, text: '' }]);
  }
  // Prefer source files with the most matching terms.
  const ranked = [...files].sort((a, b) => new Set(b[1].map((h) => h.term)).size - new Set(a[1].map((h) => h.term)).size || b[1].length - a[1].length).slice(0, MAX_FILES);
  const commits = new Map();
  const addCommits = (list, reason) => {
    for (const c of list) {
      const prev = commits.get(c.hash);
      if (prev) prev.reasons.add(reason); else commits.set(c.hash, { ...c, reasons: new Set([reason]) });
    }
  };
  if (ranked.length) {
    const out = await git(top, ['log', '-n', '100', '--no-merges', LOG_FORMAT, '--name-only', '--', ...ranked.map(([f]) => f)]);
    addCommits(parseLog(out), 'changed a matching file');
  }
  for (const term of terms.filter((t) => t && t.length >= 4).slice(0, 2)) {
    const out = await git(top, ['log', '-n', '30', '--no-merges', '-S', term, LOG_FORMAT, '--name-only'], { timeout: 60000 });
    addCommits(parseLog(out), `added or removed "${term}"`);
  }
  return {
    repo: top, branch,
    files: ranked.map(([file, hits]) => ({ file, hits })),
    commits: [...commits.values()].map((c) => ({ ...c, reasons: [...c.reasons] })).sort((a, b) => b.date.localeCompare(a.date)),
  };
}

// ---- repository panel: branches, status, switching
const BRANCH_FORMAT = '%(HEAD)%1f%(refname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:iso-strict)%1f%(subject)';

function parseBranches(out, remote) {
  return out.split('\n').filter(Boolean).map((l) => {
    const [head, name, upstream, track, date, subject] = l.split('\x1f');
    const ahead = /ahead (\d+)/.exec(track || '')?.[1], behind = /behind (\d+)/.exec(track || '')?.[1];
    return { name, current: head === '*', upstream: upstream || '', ahead: Number(ahead || 0), behind: Number(behind || 0), gone: /gone/.test(track || ''), date, subject, remote };
  }).filter((b) => !b.name.endsWith('/HEAD'));
}

// `git status --porcelain=v1` lines → [{ code, file }]
const parseStatus = (out) => out.split('\n').filter(Boolean).map((l) => ({ code: l.slice(0, 2), file: l.slice(3) }));

async function repoStatus(folder) {
  const { top, branch } = await repoInfo(folder);
  const [local, remote, status, head] = await Promise.all([
    git(top, ['for-each-ref', `--format=${BRANCH_FORMAT}`, '--sort=-committerdate', 'refs/heads']),
    git(top, ['for-each-ref', `--format=${BRANCH_FORMAT}`, '--sort=-committerdate', 'refs/remotes']),
    git(top, ['status', '--porcelain=v1', '--untracked-files=normal']),
    git(top, ['log', '-1', '--format=%h%x1f%s%x1f%an%x1f%aI']).catch(() => ''),
  ]);
  const [short, subject, author, date] = head.trim().split('\x1f');
  return {
    repo: top, branch, detached: branch === 'HEAD',
    head: short ? { short, subject, author, date } : null,
    local: parseBranches(local, false), remote: parseBranches(remote, true),
    changes: parseStatus(status),
  };
}

const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]+(?<![./])$/;

// Switch to a local branch, a remote branch (creates a tracking branch), or create a new one.
async function checkout({ folder, branch, create = false, from = '' }) {
  if (!BRANCH_NAME.test(branch)) throw new Error(`"${branch}" is not a valid branch name`);
  // The start point too: anything starting with "-" would reach git as an option.
  if (from && !BRANCH_NAME.test(from)) throw new Error(`"${from}" is not a valid branch or commit to start from`);
  const { top } = await repoInfo(folder);
  if (create) await git(top, ['switch', '-c', branch, ...(from ? [from] : [])]);
  else if (/^[^/]+\//.test(branch) && !(await git(top, ['branch', '--list', branch])).trim()
    && (await git(top, ['branch', '-r', '--list', branch])).trim()) await git(top, ['switch', '--track', branch]);
  else await git(top, ['switch', branch]);
  return repoStatus(top);
}

async function fetchAll(folder) {
  const { top } = await repoInfo(folder);
  await git(top, ['fetch', '--all', '--prune'], { timeout: 120000 });
  return repoStatus(top);
}

const MAX_DIFF = 400 * 1024;
async function show({ folder, hash, files = [] }) {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error('Bad commit id');
  const { top } = await repoInfo(folder);
  const out = await git(top, ['show', '--stat', '--patch', '--format=fuller', hash, '--', ...files]);
  return { text: out.length > MAX_DIFF ? out.slice(0, MAX_DIFF) + '\n…(diff truncated)' : out };
}

// Commits that changed one file (following renames), newest first. For "compare a spec with an older version".
async function fileVersions({ file, limit = 40 }) {
  const dir = path.dirname(file);
  const { top } = await repoInfo(dir);
  const rel = path.relative(top, file).split(path.sep).join('/');
  const out = await git(top, ['log', `-n${limit}`, '--follow', LOG_FORMAT, '--name-only', '--', rel]);
  // With --follow the listed name is the file's path in that commit (it may have moved since).
  return { top, rel, commits: parseLog(out).map((c) => ({ ...c, path: c.files[0] || rel })) };
}

// A file's text as of a commit (repo-relative path, as fileVersions lists it).
async function fileAt({ file, hash, rel }) {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error('Bad commit id');
  const { top } = await repoInfo(path.dirname(file));
  return { text: await git(top, ['show', `${hash}:${rel}`]) };
}

const guard = (fn) => async (_e, arg) => { try { return { ok: true, ...(await fn(arg)) }; } catch (err) { return { ok: false, error: err.message }; } };

function register(ipcMain) {
  ipcMain.handle('git-info', guard((folder) => repoInfo(folder)));
  ipcMain.handle('git-request-history', guard(requestHistory));
  ipcMain.handle('git-show', guard(show));
  ipcMain.handle('git-status', guard(repoStatus));
  ipcMain.handle('git-checkout', guard(checkout));
  ipcMain.handle('git-fetch', guard(fetchAll));
  ipcMain.handle('git-file-versions', guard(fileVersions));
  ipcMain.handle('git-file-at', guard(fileAt));
}

module.exports = { requestHistory, fileVersions, fileAt, show, repoInfo, repoStatus, checkout, fetchAll, parseLog, parseGrep, register };
