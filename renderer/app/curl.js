// cURL command ⇄ request conversion (Import cURL / the cURL button).

// Shell-style word splitting: '…', "…" (bash escapes only \ " $ `), $'…' ANSI-C quoting
// (what Chrome's "Copy as cURL" emits for bodies with special characters) and bare \x escapes.
const ANSI_C = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
const ANSI_C_ESC = /x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|([0-7]{1,3})|([\s\S])/y;

export function tokenize(str) {
  const out = []; let cur = '', q = null, has = false;
  str = str.replace(/\\\r?\n/g, ' ');
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; }
    else if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < str.length && '"\\$`'.includes(str[i + 1])) cur += str[++i];
      else cur += c;
    } else if (q === "$'") {
      if (c === "'") q = null;
      else if (c === '\\' && i + 1 < str.length) {
        ANSI_C_ESC.lastIndex = i + 1;
        const m = ANSI_C_ESC.exec(str); i += m[0].length;
        const hex = m[1] || m[2];
        cur += hex ? String.fromCharCode(parseInt(hex, 16)) : m[3] ? String.fromCharCode(parseInt(m[3], 8)) : ANSI_C[m[4]] ?? '\\' + m[4];
      } else cur += c;
    } else if (c === '$' && str[i + 1] === "'") { q = "$'"; has = true; i++; }
    else if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === '\\' && i + 1 < str.length) cur += str[++i];
    else if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; }
    else cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

// curl options whose next word is a value we don't use (so it isn't mistaken for the URL).
const CURL_VALUE_OPTS = new Set(['-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '-w', '--write-out',
  '--retry', '-T', '--upload-file', '-c', '--cookie-jar', '-F', '--form', '-r', '--range', '-E', '--cert', '--cacert', '--key',
  '--resolve', '--interface', '--limit-rate', '-K', '--config', '-U', '--proxy-user', '-z', '--time-cond', '--max-redirs']);
const DATA_OPTS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii']);

// Returns the request fields (no id); the caller merges them into newReq().
export function parseCurl(cmd) {
  const t = tokenize(cmd.trim());
  const req = { name: 'Imported', method: '', url: '', headers: [], body: { type: 'none', text: '' }, auth: { type: 'inherit' }, assertions: [] };
  const data = []; let getMode = false;
  const header = (k, v) => req.headers.push({ k, v, on: true });
  const next = (i) => t[i] || '';
  for (let i = 0; i < t.length; i++) {
    const a = t[i];
    if (i === 0 && a === 'curl') continue;
    if (a === '-X' || a === '--request') req.method = next(++i).toUpperCase();
    else if (/^-X\w+$/.test(a)) req.method = a.slice(2).toUpperCase();
    else if (a === '-H' || a === '--header') {
      const h = next(++i); const ix = h.indexOf(':');
      if (ix > 0) header(h.slice(0, ix).trim(), h.slice(ix + 1).trim());
    } else if (DATA_OPTS.has(a)) data.push(next(++i));
    else if (a === '--data-urlencode') {
      const v = next(++i); const ix = v.indexOf('=');
      data.push(ix < 0 ? encodeURIComponent(v) : v.slice(0, ix + 1) + encodeURIComponent(v.slice(ix + 1)));
    } else if (a === '--json') { data.push(next(++i)); header('Content-Type', 'application/json'); header('Accept', 'application/json'); }
    else if (a === '-u' || a === '--user') {
      const [user, ...p] = next(++i).split(':'); req.auth = { type: 'basic', user, pass: p.join(':') };
    } else if (a === '-b' || a === '--cookie') header('Cookie', next(++i));
    else if (a === '-A' || a === '--user-agent') header('User-Agent', next(++i));
    else if (a === '-e' || a === '--referer') header('Referer', next(++i));
    else if (a === '--url') req.url = next(++i);
    else if (a === '-G' || a === '--get') getMode = true;
    else if (a === '-I' || a === '--head') req.method = req.method || 'HEAD';
    else if (CURL_VALUE_OPTS.has(a)) i++;
    else if (a.startsWith('-')) continue;
    else if (!req.url) req.url = a;
  }
  // curl joins repeated -d values with '&'; -G moves them into the query string instead.
  const text = data.join('&');
  if (getMode && text) req.url += (req.url.includes('?') ? '&' : '?') + text;
  else if (data.length) {
    req.body = { type: 'raw', text };
    // curl sends -d data as a form unless told otherwise; fetch would default to text/plain.
    if (!req.headers.some((h) => h.k.toLowerCase() === 'content-type')) header('Content-Type', 'application/x-www-form-urlencoded');
  }
  if (!req.method) req.method = data.length && !getMode ? 'POST' : 'GET';
  try { req.name = new URL(req.url).pathname || 'Imported'; } catch {}
  return req;
}

// Takes the output of buildRequest (http.js), so the exported command matches what Send actually sends.
export function toCurl(req) {
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  let s = `curl -X ${req.method} ${q(req.url)}`;
  if (req.redirect === 'follow') s += ' -L';
  if (req.timeoutMs) s += ` --max-time ${req.timeoutMs / 1000}`;
  for (const [k, v] of Object.entries(req.headers)) s += ` \\\n  -H ${q(k + ': ' + v)}`;
  if (req.body) s += ` \\\n  --data-raw ${q(req.body)}`;
  return s;
}
