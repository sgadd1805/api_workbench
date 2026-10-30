// Fixes from the security review: server data escaped, request-file folder kept inside the code folder,
// git start points checked, credentials kept out of the Tools window's history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

globalThis.window = { electronAPI: { storageSet() {} } };
const require = createRequire(import.meta.url);
const { loggerRows } = await import('../renderer/app/actuator.js');
const { safeRepoSubdir, repoDir } = await import('../renderer/app/repo.js');
const { DB, normalizeDB } = await import('../renderer/app/store.js');
const { applyConfig } = await import('../renderer/app/config.js');
const { redactCredentials } = await import('../renderer/shared/redact.js');
const { checkout } = require('../main/git.js');

test('Actuator: log level names from the server are plain words only', () => {
  const { levels } = loggerRows({ levels: ['OFF', 'INFO', '<img src=x onerror=alert(1)>', 'DEBUG', 42], loggers: {} });
  assert.deepEqual(levels, ['OFF', 'INFO', 'DEBUG']);
  assert.deepEqual(loggerRows({ levels: ['<b>'] }).levels, ['OFF', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'], 'nothing usable: the standard list');
});

test('request-file folder: relative and inside the code folder only', () => {
  for (const ok of ['api-requests', 'tests/http', './api']) assert.equal(safeRepoSubdir(ok), true, ok);
  for (const bad of ['../other', 'a/../../b', '/etc', 'C:\\\\x', '~/x', '..', '']) assert.equal(safeRepoSubdir(bad), false, bad);
  assert.equal(repoDir({ codeFolder: '/work/pets', repo: { dir: '../../home' } }), '/work/pets/api-requests');
  assert.equal(repoDir({ codeFolder: '/work/pets', repo: { dir: 'http' } }), '/work/pets/http');
  Object.assign(DB, { projects: [], features: [], notes: [], tokenSources: [], settings: {} }); normalizeDB(DB);
  const res = applyConfig({ project: { name: 'P', repoDir: '../../elsewhere', repoSync: true } });
  assert.deepEqual([res.project.repo.dir, res.project.repo.auto], [undefined, true]);
  assert.match(res.warnings[0], /repoDir "..\/..\/elsewhere" was ignored/);
});

test('git: a start point that looks like an option is refused before git runs', async () => {
  await assert.rejects(checkout({ folder: '/nowhere', branch: 'feature/x', create: true, from: '--orphan' }), /not a valid branch or commit to start from/);
  await assert.rejects(checkout({ folder: '/nowhere', branch: '-b' }), /not a valid branch name/);
});

test('Tools history: credentials blanked', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
  const cases = [
    ['{"user":"bo","password":"hunter2","id":7,"apiKey":12345}', '{"user":"bo","password":"[redacted]","id":7,"apiKey":"[redacted]"}'],
    ['https://x.test/cb?code=1&access_token=abc123&state=s', 'https://x.test/cb?code=1&access_token=[redacted]&state=s'],
    ['Authorization: Bearer abcdefghijkl', 'Authorization: [redacted] [redacted]'],
    [`token ${jwt} here`, 'token [redacted] here'],
    ['-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----', '[redacted]'],
    ['just some text with author: Rae', 'just some text with author: Rae'],
    ['GET http://127.0.0.1:8080/login?api_key=KEY-7777&page=2', 'GET http://127.0.0.1:8080/login?api_key=[redacted]&page=2'],
    ['grant_type=password&username=bo&password=hunter2', 'grant_type=password&username=bo&password=[redacted]'],
  ];
  for (const [input, want] of cases) assert.equal(redactCredentials(input), want, input);
});
