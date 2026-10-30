'use strict';
// Replacing a data file in one step: write a temp file, then rename it over the old one, so a crash
// mid-write can't leave a truncated file. On Windows the rename can fail for a moment (EPERM / EBUSY /
// EACCES) while antivirus or the search indexer has the old file open; it is retried, and as a last
// resort the file is written in place.
const fs = require('fs');

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const pause = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* short synchronous wait */ } };

// rename: injectable for tests.
function replaceFile(file, data, { mode, rename = fs.renameSync } = {}) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  for (let attempt = 0; ; attempt++) {
    try { rename(tmp, file); return; } catch (err) {
      if (!BUSY.has(err.code)) throw err;
      if (attempt >= 5) break;
      pause(20 * (attempt + 1));
    }
  }
  fs.writeFileSync(file, data, mode ? { mode } : undefined);
  try { fs.rmSync(tmp, { force: true }); } catch { /* left for the next save */ }
}

module.exports = { replaceFile };
