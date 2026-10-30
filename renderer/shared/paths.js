// File paths as the renderer sees them: from macOS / Linux (/home/me/x) or Windows (C:\Users\me\x, \\server\share,
// sometimes with forward slashes). The renderer has no `path` module, so these work on either form.

// Absolute: /x, \x, C:\x, C:/x, \\server\share — or an http(s) URL (specs).
export const isAbsPath = (p) => /^([/\\]|[A-Za-z]:[\\/]|https?:\/\/)/i.test(String(p || ''));
const isWindowsPath = (p) => /^[A-Za-z]:[\\/]|^\\\\/.test(p);
const trimEnd = (p) => p.replace(/[\\/]+$/, '');

// base + relative path, in base's own separator style (so C:\code + proto/x.proto → C:\code\proto\x.proto).
// An absolute rel is returned as it is.
export function joinPath(base, rel) {
  if (!base || isAbsPath(rel)) return rel;
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${trimEnd(base)}${sep}${String(rel).replace(/^\.[\\/]/, '').replace(/[\\/]+/g, sep)}`;
}

// file relative to base with "/" separators (portable, for files shared through git), or file unchanged
// when it isn't inside base. Windows paths compare case-insensitively and with either separator.
export function relPath(base, file) {
  if (!base || !file) return file;
  const norm = (p) => trimEnd(String(p).replace(/\\/g, '/'));
  const win = isWindowsPath(base) || isWindowsPath(file);
  const b = norm(base), f = norm(file);
  const inside = win ? f.toLowerCase().startsWith(b.toLowerCase() + '/') : f.startsWith(b + '/');
  return inside ? f.slice(b.length + 1) : file;
}
