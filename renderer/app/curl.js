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

// One -F value → a multipart row: name=value, name=@file[;type=…][;filename=…], or name=<file (also sent as a file part).
function formPart(spec) {
  const ix = spec.indexOf('=');
  const k = ix < 0 ? spec : spec.slice(0, ix), v = ix < 0 ? '' : spec.slice(ix + 1);
  if (!/^[@<]/.test(v)) return { k, v, on: true };
  const [file, ...attrs] = v.slice(1).split(';');
  const type = attrs.map((a) => /^\s*type=(.+)$/i.exec(a)?.[1]).find(Boolean);
  return { k, v: file.replace(/^"(.*)"$/, '$1'), on: true, file: true, ...(type && { type: type.trim() }) };
}

// Returns the request fields (no id); the caller merges them into newReq().
export function parseCurl(cmd) {
  const t = tokenize(cmd.trim());
  const req = { name: 'Imported', method: '', url: '', headers: [], body: { type: 'none', text: '' }, auth: { type: 'inherit' }, assertions: [] };
  const data = [], parts = []; let getMode = false, upload = '';
  const header = (k, v) => req.headers.push({ k, v, on: true });
  const next = (i) => t[i] || '';
  for (let i = 0; i < t.length; i++) {
    const a = t[i];
    if (i === 0 && a === 'curl') continue;
    if (a === '-F' || a === '--form') parts.push(formPart(next(++i)));
    else if (a === '--form-string') { const v = next(++i), ix = v.indexOf('='); parts.push({ k: ix < 0 ? v : v.slice(0, ix), v: ix < 0 ? '' : v.slice(ix + 1), on: true }); }
    else if (a === '-T' || a === '--upload-file') upload = next(++i);
    else if (a === '-X' || a === '--request') req.method = next(++i).toUpperCase();
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
  // -F parts → a multipart body; -T file or a single --data-binary @file → that file as the body.
  const dataFile = data.length === 1 && data[0].startsWith('@') ? data[0].slice(1) : '';
  if (parts.length) {
    req.body = { type: 'multipart', text: '', form: parts };
    // The boundary in a copied multipart Content-Type belongs to that other body; the app sets its own.
    req.headers = req.headers.filter((h) => !(/^content-type$/i.test(h.k) && /^multipart\//i.test(h.v)));
    if (!req.method) req.method = 'POST';
  } else if (upload || (dataFile && !getMode)) {
    req.body = { type: 'binary', text: '', form: [], file: upload || dataFile };
    if (!req.method) req.method = upload ? 'PUT' : 'POST';
  } else if (getMode && text) req.url += (req.url.includes('?') ? '&' : '?') + text;
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
  // curl writes the multipart Content-Type itself (with its own boundary).
  const skip = (k, v) => req.bodyParts?.length && /^content-type$/i.test(k) && /^multipart\//i.test(v);
  for (const [k, v] of Object.entries(req.headers)) if (!skip(k, v)) s += ` \\\n  -H ${q(k + ': ' + v)}`;
  if (req.bodyParts?.length) {
    for (const p of req.bodyParts) {
      s += p.file != null
        ? ` \\\n  -F ${q(`${p.name}=@${p.file}${p.contentType ? `;type=${p.contentType}` : ''}`)}`
        : ` \\\n  --form-string ${q(`${p.name}=${p.value ?? ''}`)}`;
    }
  } else if (req.bodyFile) s += ` \\\n  --data-binary ${q('@' + req.bodyFile)}`;
  else if (req.body) s += ` \\\n  --data-raw ${q(req.body)}`;
  return s;
}
