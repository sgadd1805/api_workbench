'use strict';
// Which values in db.json are secrets — redacted from History, left out of exports, and sealed on disk as
// { $secret: <ciphertext> } when encryption is on (main/vault.js; main/storage.js seals on save and opens on
// load). encrypt / decrypt are passed in, so this is testable.
//
// Secrets: auth.token / auth.pass (requests, folders, projects), project.cookies, env.network.passphrase,
// environment variables marked { secret: true }, and the MCP server's token (settings.mcp.token).

const isSealed = (v) => v && typeof v === 'object' && typeof v.$secret === 'string';

function walk(db, fn) {
  const auth = (a) => { if (a) { fn(a, 'token'); fn(a, 'pass'); } };
  if (db.settings?.mcp) fn(db.settings.mcp, 'token'); // the MCP server's bearer token
  for (const p of db.projects || []) {
    auth(p.auth); fn(p, 'cookies');
    for (const f of p.folders || []) { auth(f.auth); for (const r of f.requests || []) auth(r.auth); }
    for (const r of p.requests || []) auth(r.auth);
    for (const e of p.envs || []) {
      if (e.network) fn(e.network, 'passphrase');
      for (const v of e.vars || []) if (v.secret) fn(v, 'v');
    }
  }
}

// Seals every secret in place: a non-empty value becomes { $secret: encrypt(value) }. → number sealed
function sealSecrets(db, encrypt) {
  let n = 0;
  walk(db, (obj, key) => { if (typeof obj[key] === 'string' && obj[key]) { obj[key] = { $secret: encrypt(obj[key]) }; n++; } });
  return n;
}

// Opens sealed values in place. A value that can't be decrypted (sealed on another computer or for another
// user account) becomes ''. → number that couldn't be opened
function openSecrets(db, decrypt) {
  let failed = 0;
  walk(db, (obj, key) => { if (isSealed(obj[key])) { try { obj[key] = decrypt(obj[key].$secret); } catch { obj[key] = ''; failed++; } } });
  return failed;
}

// Header values that are credentials; redacted in history.json.
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'x-auth-token', 'x-csrf-token']);
const REDACTED = '•••• (redacted)';
function redactHeaders(headers) {
  if (!headers) return headers;
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : v]));
}

// The same, with an asynchronous encrypt / decrypt (main/vault.js uses safeStorage's async API).
async function sealSecretsAsync(db, encrypt) {
  const jobs = [];
  walk(db, (obj, key) => { if (typeof obj[key] === 'string' && obj[key]) jobs.push(encrypt(obj[key]).then((c) => { obj[key] = { $secret: c }; })); });
  await Promise.all(jobs);
  return jobs.length;
}
async function openSecretsAsync(db, decrypt) {
  let failed = 0;
  const jobs = [];
  walk(db, (obj, key) => { if (isSealed(obj[key])) jobs.push(decrypt(obj[key].$secret).then((v) => { obj[key] = v; }, () => { obj[key] = ''; failed++; })); });
  await Promise.all(jobs);
  return failed;
}

// One value: sealed when `encrypt` is given and the value isn't empty. → Promise<string | { $secret }>
const sealValue = async (v, encrypt) => (encrypt && typeof v === 'string' && v ? { $secret: await encrypt(v) } : v);
// One value, opened. → Promise<{ value, failed }>
async function openValue(v, decrypt) {
  if (!isSealed(v)) return { value: v ?? '', failed: false };
  try { return { value: await decrypt(v.$secret), failed: false }; } catch { return { value: '', failed: true }; }
}

const hasSealed = (db) => JSON.stringify(db ?? null).includes('"$secret"');

// Every secret value saved in db.json (see walk), with cookie jars split into their values. → [string]
function secretValues(db) {
  const out = [];
  walk(db || {}, (obj, key) => {
    const v = obj[key];
    if (typeof v !== 'string' || !v) return;
    out.push(v);
    if (key === 'cookies') for (const part of v.split(';')) { const i = part.indexOf('='); if (i > 0) out.push(part.slice(i + 1).trim()); }
  });
  return out;
}

// ---- Free-text redaction (Claude prompts): bodies, log lines, page HTML, anything not a header map.

const HIDDEN = '[REDACTED]';
// A field name that holds a credential: key / sig, password / passwd / passphrase, secret, api key, access /
// private key, credential(s), or ending in token / pass / pwd / otp / cookie / session id / signature / authorization.
// Matched on the name lower-cased with '-' and '_' removed, so client_secret, X-Api-Key and csrfToken all match.
const SECRET_NAME = /(^(key|sig)$|password|passwd|passphrase|secret|apikey|accesskey|privatekey|credential|(token|pass|pwd|otp|cookie|sessionid|sid|signature|authorization)s?$)/;
const isSecretName = (name) => SECRET_NAME.test(String(name).toLowerCase().replace(/[-_]/g, ''));
const NAME = '[A-Za-z][\\w.-]*';

// Values that look like credentials whatever field they are in.
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, // JWT
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g, // Stripe / OpenAI / Anthropic style keys
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{10,}/g, // GitHub / GitLab / Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
];

// Replaces the value after each secret-named field `field` finds (named groups: name, and q for a quote).
// Scanning field by field, rather than one replace over name + value, means a harmless field's value isn't
// consumed: in `URL: https://x/?token=abc`, token is still reached. `value(m)` matches the value at the
// start of the rest of the text, and hide(v, m) gives its replacement.
function redactFields(s, field, value, hide) {
  let out = '', last = 0, m;
  field.lastIndex = 0;
  while ((m = field.exec(s))) {
    const end = m.index + m[0].length;
    const v = isSecretName(m.groups.name) && value(m).exec(s.slice(end));
    if (!v || v[0].includes('[REDACTED')) continue; // already removed
    out += s.slice(last, end) + hide(v, m);
    last = field.lastIndex = end + v[0].length;
  }
  return out + s.slice(last);
}
const JSON_FIELD = new RegExp(`(?<q>\\\\?["'])(?<name>${NAME})\\k<q>\\s*:\\s*`, 'g');
const JSON_VALUE = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,}\]\s]+)/;
const ESCAPED_JSON_VALUE = /^\\"(?:(?!\\").)*\\"/; // inside a JSON string: {\"password\":\"x\"}
const INLINE_FIELD = new RegExp(`(?:^|[^\\w.-])(?<name>${NAME})(?:\\s*=\\s*|:\\s*)`, 'g');
const INLINE_VALUE = /^(["']?)((?:Bearer|Basic|Digest|Token)\s+)?([^\s&;,"'<>)}\]\\]+)\1/i; // the auth scheme is kept

// text with credentials replaced by [REDACTED]:
// - every known secret value (from secretValues, test-account passwords, cached tokens; 4+ characters);
// - values that look like credentials (private keys, JWTs, well-known API key formats);
// - the scheme's credential after Bearer / Basic / Token / Digest, and passwords in URLs (user:pass@host);
// - values of secret-named fields: JSON ("password": "x"), form and query (token=x), headers, YAML
//   and log lines (Authorization: x), and HTML inputs (type="password", or a secret-looking name).
function redactText(text, known = []) {
  if (text == null || text === '') return text;
  let s = String(text);
  const plain = known.filter((v) => typeof v === 'string' && v.trim().length >= 4);
  const values = [...new Set([...plain, ...plain.map(encodeURIComponent)])].sort((a, b) => b.length - a.length);
  for (const v of values) s = s.split(v).join(HIDDEN);
  for (const re of SECRET_SHAPES) s = s.replace(re, HIDDEN);
  s = s.replace(/\b(Bearer|Basic|Token|Digest)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme, sp) => scheme + sp + HIDDEN);
  s = s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'<>]+:)[^\s@/"'<>]+@/gi, `$1${HIDDEN}@`);
  // "name": "value" / 'name': value (null and "" are kept: they hold nothing)
  s = redactFields(s, JSON_FIELD, (m) => (m.groups.q.length > 1 ? ESCAPED_JSON_VALUE : JSON_VALUE),
    (v, m) => (v[0] === 'null' || v[0] === '""' ? v[0] : m.groups.q.length > 1 ? `\\"${HIDDEN}\\"` : `"${HIDDEN}"`));
  // A whole line that is `Name: value` (headers, YAML, .properties) — the rest of the line.
  s = s.replace(new RegExp(`^(\\s*-?\\s*)(${NAME})(\\s*[:=]\\s*)(\\S.*)$`, 'gm'),
    (m, lead, name, sep, v) => (isSecretName(name) && !v.startsWith(HIDDEN) && !/^[{[]\s*$/.test(v) ? lead + name + sep + HIDDEN : m));
  // name=value / name: value inside a line (query strings, form bodies, log messages, HTML attributes).
  s = redactFields(s, INLINE_FIELD, () => INLINE_VALUE, (v) => v[1] + (v[2] || '') + HIDDEN + v[1]);
  // <input type="password" value="x"> and <input name="csrf_token" value="x">
  s = s.replace(/<input\b[^>]*>/gi, (tag) => {
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1] || '';
    if (!/\btype\s*=\s*["']?password\b/i.test(tag) && !isSecretName(name)) return tag;
    return tag.replace(/(\bvalue\s*=\s*)(["'])[\s\S]*?\2/i, `$1$2${HIDDEN}$2`);
  });
  return s;
}

module.exports = { openSecrets, sealSecrets, openSecretsAsync, sealSecretsAsync, sealValue, openValue, isSealed, hasSealed, redactHeaders, redactText, secretValues, isSecretName, REDACTED, SENSITIVE_HEADERS };
