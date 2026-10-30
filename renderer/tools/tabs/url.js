import { esc, copyText } from '../../shared/html.js';
import { twoPanes } from '../lib/ui.js';

// A URL's parts and decoded query parameters, when the text is a URL. → html | ''
export function urlPartsHtml(text) {
  let u; try { u = new URL(text.trim()); } catch { return ''; }
  const row = (k, v) => (v ? `<span class="hint">${k}</span><code>${esc(v)}</code>` : '');
  const params = [...u.searchParams];
  return `<h4 class="section-title mt-10">Parts</h4><div class="jwt-facts">
      ${row('Scheme', u.protocol.replace(/:$/, ''))}${row('Host', u.hostname)}${row('Port', u.port)}${row('Path', decodeURIComponent(u.pathname))}${row('Fragment', u.hash.slice(1))}${row('User', u.username)}</div>
    ${params.length ? `<h4 class="section-title mt-10">Query parameters (${params.length})</h4>
      <table class="diff-fields">${params.map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td><code>${esc(v)}</code></td><td><button class="btn-ghost small" data-copy="${esc(v)}">Copy</button></td></tr>`).join('')}</table>` : ''}`;
}

export default {
  id: 'url', label: 'URL',
  state: { urlInput: '', urlDecoded: '' },
  keys: ['urlInput', 'urlDecoded'],
  primary: (S) => S.urlInput || S.urlDecoded,
  receive(S, value) { S.urlDecoded = value; try { S.urlInput = decodeURIComponent(value); } catch { S.urlInput = ''; } },
  render: (S) => twoPanes(
    `<label class="hint">Plain text → encode</label><textarea id="url-encode" rows="8" placeholder="Plain text…" spellcheck="false">${esc(S.urlInput)}</textarea>`,
    `<label class="hint">URL-encoded → decode</label><textarea id="url-decode" rows="8" placeholder="URL-encoded…" spellcheck="false">${esc(S.urlDecoded)}</textarea>`)
    + urlPartsHtml(S.urlInput),
  onInput(el, { S, changed }) {
    if (el.id === 'url-encode') { S.urlInput = el.value; S.urlDecoded = encodeURIComponent(el.value); }
    else if (el.id === 'url-decode') { S.urlDecoded = el.value; try { S.urlInput = decodeURIComponent(el.value); } catch {} }
    else return;
    changed(el);
  },
  onClick(t) { const c = t.closest('[data-copy]'); if (c) copyText(c.dataset.copy); },
};
