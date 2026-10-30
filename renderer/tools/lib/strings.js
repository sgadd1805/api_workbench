// String tab operations: [id, button label, transform].
export const STRING_OPS = [
  ['trim', 'Trim', (s) => s.trim()],
  ['upper', 'Uppercase', (s) => s.toUpperCase()],
  ['lower', 'Lowercase', (s) => s.toLowerCase()],
  ['escape-json', 'Escape JSON', (s) => JSON.stringify(s).slice(1, -1)],
  ['unescape-json', 'Unescape JSON', unescapeJson],
  ['remove-blank', 'Remove blank lines', (s) => s.split('\n').filter((l) => l.trim()).join('\n')],
  ['sort-lines', 'Sort lines', (s) => s.split('\n').sort().join('\n')],
  ['reverse-lines', 'Reverse lines', (s) => s.split('\n').reverse().join('\n')],
  ['dedup-lines', 'Dedup lines', (s) => [...new Set(s.split('\n'))].join('\n')],
];

// Escape only bare quotes/control chars; already-escaped sequences like \" must pass through untouched.
// Returns the input unchanged when it isn't a valid JSON string body.
export function unescapeJson(s) {
  const CTRL = { '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  try { return JSON.parse('"' + s.replace(/\\[\s\S]|["\n\r\t]/g, (m) => CTRL[m] || m) + '"'); } catch { return s; }
}
