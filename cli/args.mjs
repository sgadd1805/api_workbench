// Command-line arguments for bin/api-workbench.js. parseCli(argv) → { command, ... } or throws UsageError.
import { parseArgs } from 'node:util';

export class UsageError extends Error {}

export const USAGE = `Usage:
  api-workbench run [<project>] [options]   run a project's requests (or one folder / feature) and report pass / fail
  api-workbench list [options]              list projects, with their environments, folders and features
  api-workbench --help | --version

Where the project comes from (one of):
  <project>                 a project in the app's data, by name
  --data <dir>              the app's data folder (default: the app's own user-data folder)
  --config <file>           an api-client.json; <project> may then be left out

What to run:
  -e, --env <name>          environment (default: the project's active one)
  -f, --folder <name>       only this folder
      --feature <name>      only the requests of this feature group
  -n, --iterations <n>      run everything n times (default 1)
  -d, --data-file <file>    CSV (first row = column names) or JSON array: one pass per row, columns as variables
      --delay <ms>          pause between requests
      --bail                stop at the first failure
      --var <name=value>    set a variable (repeatable); AW_VAR_<name> environment variables work too

Network (override the environment's Network settings):
  -k, --insecure            don't check TLS certificates
      --ca-file <file>      extra trusted CA certificate (PEM)
      --cert <file> --key <file> | --pfx <file>   client certificate; passphrase from AW_PASSPHRASE
      --proxy <url>         http://[user:pass@]host:port
      --http2               HTTP/2 for https URLs

Output:
      --junit <file>        write JUnit XML
      --json <file>         write the results as JSON
  -v, --verbose             also show script logs and warnings
      --no-color            plain text (also NO_COLOR=1)

Exit code: 0 all passed, 1 something failed, 2 bad arguments or setup.`;

const OPTIONS = {
  data: { type: 'string' },
  config: { type: 'string' },
  env: { type: 'string', short: 'e' },
  folder: { type: 'string', short: 'f' },
  feature: { type: 'string' },
  iterations: { type: 'string', short: 'n' },
  'data-file': { type: 'string', short: 'd' },
  delay: { type: 'string' },
  bail: { type: 'boolean' },
  var: { type: 'string', multiple: true },
  insecure: { type: 'boolean', short: 'k' },
  'ca-file': { type: 'string' },
  cert: { type: 'string' },
  key: { type: 'string' },
  pfx: { type: 'string' },
  proxy: { type: 'string' },
  http2: { type: 'boolean' },
  junit: { type: 'string' },
  json: { type: 'string' },
  verbose: { type: 'boolean', short: 'v' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

const int = (s, name, min) => {
  if (s === undefined) return undefined;
  if (!/^\d+$/.test(s) || Number(s) < min) throw new UsageError(`--${name} must be a whole number${min ? ` of at least ${min}` : ''}, not "${s}"`);
  return Number(s);
};

// "name=value" → [name, value]; the value may itself contain '='.
export function parseVar(s) {
  const i = s.indexOf('=');
  if (i <= 0) throw new UsageError(`--var needs name=value, not "${s}"`);
  return [s.slice(0, i).trim(), s.slice(i + 1)];
}

export function parseCli(argv) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); } catch (err) { throw new UsageError(err.message); }
  const { values: v, positionals } = parsed;
  if (v.version) return { command: 'version' };
  const [command, ...rest] = positionals;
  if (v.help || !command || command === 'help') return { command: 'help' };
  if (!['run', 'list'].includes(command)) throw new UsageError(`Unknown command "${command}"`);
  if (rest.length > (command === 'run' ? 1 : 0)) throw new UsageError(`Unexpected argument "${rest.at(-1)}" (quote names that contain spaces)`);
  if (command === 'run' && !rest[0] && !v.config) throw new UsageError('Name the project to run, or give --config <api-client.json>');
  if (v.folder && v.feature) throw new UsageError('Use --folder or --feature, not both');
  if (v.cert && !v.key) throw new UsageError('--cert needs --key');
  if (v.key && !v.cert) throw new UsageError('--key needs --cert');
  const vars = (v.var || []).map(parseVar);
  const network = {
    ...(v.insecure && { insecure: true }),
    ...(v['ca-file'] && { caFile: v['ca-file'] }),
    ...(v.cert && { certFile: v.cert, keyFile: v.key, pfxFile: '' }),
    ...(v.pfx && { pfxFile: v.pfx, certFile: '', keyFile: '' }),
    ...(v.proxy && { proxy: v.proxy }),
    ...(v.http2 && { http2: true }),
  };
  return {
    command,
    project: rest[0] || null,
    dataDir: v.data || null,
    config: v.config || null,
    env: v.env ?? null,
    folder: v.folder ?? null,
    feature: v.feature ?? null,
    iterations: int(v.iterations, 'iterations', 1) ?? 1,
    dataFile: v['data-file'] || null,
    delayMs: int(v.delay, 'delay', 0) ?? 0,
    bail: !!v.bail,
    vars,
    network,
    junit: v.junit || null,
    json: v.json || null,
    verbose: !!v.verbose,
    color: !v['no-color'],
  };
}
