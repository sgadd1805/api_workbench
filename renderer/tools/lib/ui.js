// Small markup bits shared by the tool tabs.
export const PRE = 'background:var(--input-bg);padding:8px;border-radius:4px;font-size:11px;overflow:auto';

// Two side-by-side textareas (encode ⇄ decode tabs).
export const twoPanes = (left, right) => `<div style="display:flex;gap:8px">
  <div style="flex:1">${left}</div><div style="flex:1">${right}</div></div>`;
