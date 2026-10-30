// Credentials removed from text a page keeps for later (the Tools window's history): JSON fields and
// name=value / name: value pairs whose name looks like a credential, bearer / basic credentials, JWTs and
// private keys. The main process has a fuller version for prompts and History (main/secrets.js redactText).
const HIDDEN = '[redacted]';
const NAME = /(password|passwd|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|cookie|session|csrf|xsrf|signature|authorization|otp)/i;

const decodeURIComponentSafe = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export function redactCredentials(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, HIDDEN)
    .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, HIDDEN)
    .replace(/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, (_m, s, sp) => s + sp + HIDDEN)
    // "name": "value" (JSON) — only string and number values
    .replace(/("([^"\\]|\\.)*?")(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*)/g, (m, key, _c, sep) => (NAME.test(key) ? `${key}${sep}"${HIDDEN}"` : m))
    // Query strings and form bodies: ?name=value&name=value (whole URLs included)
    .replace(/([?&;]|^)([^=&#?\s]+)=([^&#\s]*)/gm, (m, pre, name, v) => (NAME.test(decodeURIComponentSafe(name)) && v && v !== HIDDEN ? `${pre}${name}=${HIDDEN}` : m))
    // name=value and name: value elsewhere (headers, YAML, logs); "http://" isn't a name: value pair
    .replace(/(^|[^\w.-])([A-Za-z][\w.-]*)(\s*=\s*|:(?!\/\/)[ \t]*)([^\s&;,"'<>]+)/gm, (m, pre, name, sep, v) => (NAME.test(name) && v !== HIDDEN && !v.startsWith('"') ? `${pre}${name}${sep}${HIDDEN}` : m));
}
