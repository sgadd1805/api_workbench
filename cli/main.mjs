// The command-line runner (bin/api-workbench.js): runs a project's requests with the app's own collection
// runner (renderer/app/runner.js), sending through main/http.js, and reports pass / fail for CI.
// main(argv, io) → exit code: 0 all passed, 1 something failed, 2 bad arguments or setup.
import { configureApi } from './node-api.mjs'; // first: installs window.electronAPI for the renderer modules
import path from 'node:path';
import { createRequire } from 'node:module';
import { DB, activeEnv } from '../renderer/app/store.js';
import { send } from '../renderer/app/http.js';
import { attachValidation } from '../renderer/app/verify.js';
import { runCollection } from '../renderer/app/runner.js';
import { parseCli, UsageError, USAGE } from './args.mjs';
import { SetupError, defaultDataDir, resetDB, loadDataDir, loadConfigFile, findProject, useEnv, applyOverrides, resolveScope, requestsFor, readDataFile } from './load.mjs';
import { consoleReporter, resultsJson, toJUnit, writeFile, knownSecrets, redactDeep } from './report.mjs';

const require = createRequire(import.meta.url);

// io: { stdout, stderr, env (process environment), cwd } — replaceable for tests.
export async function main(argv, io = {}) {
  const { stdout = process.stdout, stderr = process.stderr, env: processEnv = process.env, cwd = process.cwd() } = io;
  try {
    const args = parseCli(argv);
    if (args.command === 'help') { stdout.write(USAGE + '\n'); return 0; }
    if (args.command === 'version') { stdout.write(require('../package.json').version + '\n'); return 0; }
    const at = (f) => f && path.resolve(cwd, f);
    const warnings = loadProjects({ ...args, dataDir: at(args.dataDir), config: at(args.config) }, processEnv);
    const { project: p, warnings: more } = await pickProject({ ...args, config: at(args.config) });
    const color = args.color && !processEnv.NO_COLOR && (!!processEnv.FORCE_COLOR || !!stdout.isTTY);
    const warn = (w) => stderr.write(`${color ? '\x1b[33mwarning\x1b[0m' : 'warning'}: ${w}\n`);
    if (args.command === 'list') { [...warnings, ...more].forEach(warn); list(stdout, p); return 0; }
    return await run(p, { ...args, dataFile: at(args.dataFile), junit: at(args.junit), json: at(args.json) }, { stdout, warn, warnings: [...warnings, ...more], processEnv, cwd, color });
  } catch (err) {
    if (err instanceof UsageError) { stderr.write(`${err.message}\n\n${USAGE}\n`); return 2; }
    if (err instanceof SetupError) { stderr.write(`${err.message}\n`); return 2; }
    stderr.write(`${err?.stack || err}\n`);
    return 2;
  }
}

// Fills the in-memory DB: the app's data (unless only --config is given). → warnings
function loadProjects(args, processEnv) {
  resetDB();
  const dataDir = args.dataDir || (args.config ? null : defaultDataDir(process.platform, processEnv));
  configureApi({ dataDir });
  return dataDir ? loadDataDir(dataDir) : [];
}

// The project to run: from --config (applied onto the app's data when --data is also given), else by name.
async function pickProject(args) {
  if (!args.config) return { project: args.project ? findProject(args.project) : null, warnings: [] };
  const { project, warnings } = await loadConfigFile(args.config);
  if (args.project && findProject(args.project) !== project) throw new SetupError(`${path.basename(args.config)} describes project "${project.name}", not "${args.project}"`);
  return { project, warnings };
}

async function run(p, args, { stdout, warn, warnings, processEnv, cwd, color }) {
  const env = useEnv(p, args.env);
  const { env: runEnv, warnings: varWarnings } = applyOverrides(p, env, { vars: args.vars, network: args.network, processEnv, cwd });
  const { scope, label } = resolveScope(p, args);
  const locs = requestsFor(p, scope);
  if (!locs.length) throw new SetupError(`Nothing to run in ${label}`);
  const rows = args.dataFile ? readDataFile(args.dataFile) : [];
  for (const w of [...warnings, ...varWarnings]) warn(w);

  const passes = rows.length || args.iterations;
  const reporter = consoleReporter(stdout, { label, envName: runEnv?.name, count: locs.length, passes, nameWidth: Math.min(40, Math.max(...locs.map((l) => l.r.name.length))), verbose: args.verbose, color, github: processEnv.GITHUB_ACTIONS === 'true', processEnv });
  reporter.start();
  let stopped = false, last = null;
  const onSigint = () => { stopped = true; };
  process.once('SIGINT', onSigint);
  let results;
  try {
    results = await runCollection(locs, async (loc, vars) => (last = await attachValidation(loc, await send(loc, undefined, { vars }))),
      { iterations: args.iterations, rows, delayMs: args.delayMs, stopOnFailure: args.bail, shouldStop: () => stopped },
      (result) => reporter.result(result, last));
  } finally { process.removeListener('SIGINT', onSigint); }
  reporter.end(results, { stopped });

  const safe = redactDeep(results, knownSecrets(processEnv));
  if (args.junit) writeFile(args.junit, toJUnit(label, safe));
  if (args.json) writeFile(args.json, resultsJson({ label, project: p.name, envName: activeEnv(p)?.name, results: safe }));
  return results.length && results.every((r) => r.passed) && !stopped ? 0 : 1;
}

function list(out, only) {
  const projects = only ? [only] : DB.projects;
  if (!projects.length) { out.write('No projects.\n'); return; }
  for (const p of projects) {
    out.write(`${p.name}\n`);
    if (p.envs.length) out.write(`  environments: ${p.envs.map((e) => e.name + (e.id === p.activeEnv ? ' (active)' : '')).join(', ')}\n`);
    if (p.folders.length) out.write(`  folders: ${p.folders.map((f) => f.name).join(', ')}\n`);
    const n = p.requests.length + p.folders.reduce((k, f) => k + f.requests.length, 0);
    out.write(`  requests: ${n}\n`);
  }
  const features = DB.features.filter((f) => f.requestIds.length);
  if (features.length && !only) out.write(`\nfeature groups: ${features.map((f) => f.name).join(', ')}\n`);
}
