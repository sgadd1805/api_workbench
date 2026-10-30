import { esc } from './html.js';

// Pretty-printed JSON, or the input unchanged if it isn't JSON.
export function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

export function isJson(text) {
  try { JSON.parse(text); return true; } catch { return false; }
}

// Escapes and colours JSON text (classes json-key / json-str / json-num / json-bool / json-null).
// Only meant for JSON: on other text the number/keyword patterns would colour arbitrary words.
export function highlightJson(text) {
  return esc(text).replace(/(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (m, str, colon, bool) => {
      if (str) return `<span class="${colon ? 'json-key' : 'json-str'}">${str}</span>${colon || ''}`;
      if (bool) return `<span class="json-bool">${m}</span>`;
      if (m === 'null') return `<span class="json-null">${m}</span>`;
      return `<span class="json-num">${m}</span>`;
    });
}
