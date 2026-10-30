// Console progress and result files for a command-line run, with secret values hidden everywhere.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DB } from '../renderer/app/store.js';
import { cachedTokenValues } from '../renderer/app/tokens.js';
import { summarize, toJUnit } from '../renderer/app/runner.js';

const require = createRequire(import.meta.url);
const { redactText, secretValues, isSecretName } = require('../main/secrets.js');

// "{{token}}" or "Bearer {{token}}": names a variable (whose value is listed itself), holds no secret.
const isTemplate = (v) => !String(v).replace(/\{\{[^}]+\}\}/g, '').replace(/^\s*(Bearer|Basic|Token)?\s*$/i, '');

// Every value that must not be printed: what the app treats as secret (secretValues: auth tokens and
// passwords, cookie jars, certificate passphrases, variables marked secret), variables and token-source
// fields whose names look like credentials, the AW_PASSPHRASE, and tokens fetched during the run.
export function knownSecrets(processEnv = process.env) {
  const out = secretValues(DB).filter((v) => !isTemplate(v));
  const rows = [
    ...DB.projects.flatMap((p) => p.envs.flatMap((e) => e.vars)),
    ...DB.tokenSources.flatMap((t) => [...t.headers, ...(t.body?.form || [])]),
  ];
  for (const r of rows) if (r.k && isSecretName(r.k) && r.v && !isTemplate(r.v)) out.push(r.v);
  if (processEnv.AW_PASSPHRASE) out.push(processEnv.AW_PASSPHRASE);
  out.push(...cachedTokenValues());
  return out;
}

// Strings in a JSON-able value with secrets replaced by [REDACTED].
export function redactDeep(value, known) {
  if (typeof value === 'string') return redactText(value, known);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, known));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, known)]));
  return value;
}

const CODES = { red: 31, green: 32, yellow: 33, dim: 2, bold: 1 };
export function painter(on) {
  return Object.fromEntries(Object.entries(CODES).map(([k, c]) => [k, (s) => (on ? `\x1b[${c}m${s}\x1b[0m` : String(s))]));
}

// GitHub Actions workflow commands: failures show up as annotations on the run.
const ghData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const ghProp = (s) => ghData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

// out: a writable stream. info: { label, envName, count, passes, nameWidth, verbose, color, github, processEnv }
export function consoleReporter(out, { label, envName, count, passes, nameWidth = 0, verbose = false, color = false, github = false, processEnv = process.env }) {
  const c = painter(color);
  const hide = (s) => redactText(String(s ?? ''), knownSecrets(processEnv));
  const line = (s = '') => out.write(s + '\n');
  let iteration = 0;
  return {
    start() {
      line(c.bold(`API Workbench · ${hide(label)}${envName ? ` · environment ${hide(envName)}` : ''}`));
      line(c.dim(`${count} request${count === 1 ? '' : 's'}${passes > 1 ? ` × ${passes} passes` : ''}`));
    },
    // r: a runner result; res: the send's full result (warnings, script logs)
    result(r, res = {}) {
      if (passes > 1 && r.iteration !== iteration) { iteration = r.iteration; line(); line(c.bold(`Pass ${iteration} of ${passes}`)); }
      else if (!iteration) { iteration = r.iteration; line(); }
      const mark = r.passed ? c.green('PASS') : c.red('FAIL');
      const status = r.status == null ? c.red('ERR') : r.status >= 400 ? c.yellow(r.status) : String(r.status);
      line(`  ${mark}  ${String(r.method || '').padEnd(6)} ${hide(r.name).padEnd(nameWidth)}  ${status}  ${c.dim(`${r.time} ms`)}`);
      if (!r.passed) {
        if (r.url) line(`          ${c.dim(hide(r.url))}`);
        for (const f of r.failures) line(`          ${c.red('×')} ${hide(f)}`);
        if (github) out.write(`::error title=${ghProp(hide(`${r.method} ${r.name}`))}::${ghData(r.failures.map(hide).join('\n'))}\n`);
      }
      if (verbose || !r.passed) for (const w of res.warnings || []) line(`          ${c.yellow('!')} ${hide(w)}`);
      if (verbose) for (const l of res.scriptLogs || []) line(`          ${c.dim('log')} ${hide(l)}`);
    },
    end(results, { stopped = false } = {}) {
      const s = summarize(results);
      line();
      if (stopped) line(c.yellow('Stopped before the end.'));
      const failed = results.filter((r) => !r.passed);
      if (failed.length) {
        line(c.bold('Failed:'));
        for (const r of failed) line(`  ${c.red('×')} ${passes > 1 ? `[pass ${r.iteration}] ` : ''}${r.method} ${hide(r.name)}: ${hide(r.failures[0])}`);
        line();
      }
      const counts = `${s.passed} passed, ${s.failed} failed, ${s.total} total`;
      line(`${s.failed ? c.red(c.bold(counts)) : c.green(c.bold(counts))} ${c.dim(`(${s.time} ms)`)}`);
    },
  };
}

// The JSON export, as the app's Runner page writes it, plus the summary and environment.
export function resultsJson({ label, project, envName, results }) {
  return JSON.stringify({ name: label, project, environment: envName || null, at: new Date().toISOString(), summary: summarize(results), results }, null, 2) + '\n';
}

export function writeFile(file, content) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, content);
}

export { toJUnit };
