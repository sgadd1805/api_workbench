#!/usr/bin/env node
'use strict';
// Command-line runner for CI: `api-workbench run "Pet Store" --env staging --junit results.xml`.
// See cli/main.mjs, and "Running in CI" in README.md.
import('../cli/main.mjs').then(({ main }) => main(process.argv.slice(2))).then((code) => {
  // Keep-alive connections would hold the process open; exit once the output is written.
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
});
