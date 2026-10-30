// Small, safe Markdown subset for API descriptions: paragraphs, - / * / 1. lists, ``` code blocks,
// `code`, **bold**, *italic* / _italic_, [text](http…) links (opened in the system browser).
// Everything is escaped first, so description text can't inject markup.
import { esc } from './html.js';

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function markdown(text) {
  const blocks = [];
  const lines = esc(text || '').replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      blocks.push(`<pre class="md-code">${code.join('\n')}</pre>`);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line), items = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`);
      blocks.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push(`<p><b>${inline(line.replace(/^#+\s*/, ''))}</b></p>`); i++;
    } else if (!line.trim()) i++;
    else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^```|^\s*([-*]|\d+\.)\s+|^#{1,6}\s/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  return blocks.join('');
}
