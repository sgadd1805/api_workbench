import { esc, copyText } from '../../shared/html.js';

const FLAGS = ['g', 'i', 'm', 's'];

// Highlighted input, match count and first-match named groups for the current pattern.
function results(S) {
  const matches = [...S.regexInput.matchAll(new RegExp(S.regexPattern, S.regexFlags.includes('g') ? S.regexFlags : S.regexFlags + 'g'))];
  let highlighted = '', last = 0;
  for (const m of matches) {
    // Empty matches have nothing to highlight; matchAll itself steps past them, so don't skip input here.
    if (!m[0]) continue;
    highlighted += esc(S.regexInput.slice(last, m.index)) + `<mark style="background:#ff980055;border-radius:2px">${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  highlighted += esc(S.regexInput.slice(last));
  let html = `<div style="background:var(--input-bg);border:1px solid var(--border);border-radius:4px;padding:8px;font-family:monospace;font-size:12px;white-space:pre-wrap">${highlighted}</div>`;
  if (S.regexReplace !== '') {
    const replaced = S.regexInput.replace(new RegExp(S.regexPattern, S.regexFlags), S.regexReplace);
    html += `<div class="mt-8"><label class="hint">After replace${S.regexFlags.includes('g') ? '' : ' (first match only: add g for all)'}</label>
      <div class="row gap-6 items-start"><pre class="grow" style="background:var(--input-bg);border:1px solid var(--border);border-radius:4px;padding:8px;font-size:12px;white-space:pre-wrap;margin:4px 0">${esc(replaced)}</pre>
      <button class="btn-ghost small mt-6" id="regex-copy-replaced">Copy</button></div></div>`;
  }
  // Every match with its position and groups (numbered, then named).
  const shown = matches.filter((m) => m[0] !== '' || m.length > 1).slice(0, 200);
  if (shown.length) {
    const groupCount = Math.max(...shown.map((m) => m.length - 1));
    const names = Object.keys(shown[0].groups || {});
    const head = `<tr><th>#</th><th>At</th><th>Match</th>${Array.from({ length: groupCount }, (_, g) => `<th>$${g + 1}</th>`).join('')}${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr>`;
    const cell = (v) => `<td><code>${v === undefined ? '<span class="hint">–</span>' : esc(v)}</code></td>`;
    html += `<div class="mt-8"><label class="hint">Matches${matches.length > shown.length ? ` (first ${shown.length})` : ''}</label>
      <table class="diff-fields regex-matches">${head}${shown.map((m, i) => `<tr><td class="hint">${i + 1}</td><td class="hint">${m.index}</td>${cell(m[0])}${Array.from({ length: groupCount }, (_, g) => cell(m[g + 1])).join('')}${names.map((n) => cell(m.groups?.[n])).join('')}</tr>`).join('')}</table></div>`;
  }
  return { count: matches.length, html };
}

export default {
  id: 'regex', label: 'Regex',
  state: { regexPattern: '', regexFlags: 'gi', regexInput: '', regexReplace: '' },
  keys: ['regexPattern', 'regexFlags', 'regexInput', 'regexReplace'],
  primary: (S) => S.regexPattern,
  receive(S, value) { S.regexInput = value; },
  render(S) {
    let count = 0, html = '';
    if (S.regexPattern && S.regexInput) {
      try { ({ count, html } = results(S)); } catch (e) { html = `<p class="error-text">Invalid regex: ${esc(e.message)}</p>`; }
    }
    return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
      <input id="regex-pattern" type="text" placeholder="Pattern…" value="${esc(S.regexPattern)}" style="flex:1;font-family:monospace;font-size:13px" autocomplete="off" spellcheck="false"/>
      <span style="font-size:12px;color:var(--text-muted)">Flags:</span>
      ${FLAGS.map((f) => `<label style="display:flex;align-items:center;gap:3px;font-size:12px;cursor:pointer"><input type="checkbox" data-flag="${f}" ${S.regexFlags.includes(f) ? 'checked' : ''}/>${f}</label>`).join('')}</div>
      <textarea id="regex-input" rows="6" placeholder="Test string…" spellcheck="false">${esc(S.regexInput)}</textarea>
      <input id="regex-replace" type="text" class="w-full mt-6" placeholder="Replace with… ($1, $<name>, $& work)" value="${esc(S.regexReplace)}" style="font-family:monospace;font-size:12px" spellcheck="false"/>
      ${count || S.regexPattern ? `<div style="margin:6px 0;font-size:12px;color:var(--text-muted)">${count} match${count !== 1 ? 'es' : ''}</div>` : ''}
      ${html}`;
  },
  onInput(el, ctx) {
    if (el.id === 'regex-pattern') ctx.S.regexPattern = el.value;
    else if (el.id === 'regex-input') ctx.S.regexInput = el.value;
    else if (el.id === 'regex-replace') ctx.S.regexReplace = el.value;
    else return;
    ctx.changed(el);
  },
  onChange(el, { S, rerender }) {
    const f = el.dataset.flag; if (!f) return;
    S.regexFlags = el.checked ? S.regexFlags + f : S.regexFlags.replace(f, '');
    rerender();
  },
  onClick(t, { S }) {
    if (t.id !== 'regex-copy-replaced') return;
    try { copyText(S.regexInput.replace(new RegExp(S.regexPattern, S.regexFlags), S.regexReplace)); } catch {}
  },
};
