// The request tab bar above the editor. Clicking a tab (even from the envs/compare pages)
// switches to it; × or middle-click closes it; tabs can be dragged to reorder.
import { $, esc } from '../../shared/html.js';
import { S, findReq, methodLabel } from '../store.js';
import { icon } from '../../shared/icons.js';

function tabHtml(t) {
  const loc = findReq(t.id); if (!loc) return '';
  const { p, f, r } = loc;
  const active = S.page === 'request' && S.req?.id === t.id;
  const status = t.sending ? '<span class="req-tab-status sending" title="Sending…"></span>'
    : t.unseen ? `<span class="req-tab-status ${t.response?.error || t.response?.status >= 400 ? 'err' : 'ok'}" title="New response"></span>` : '';
  const where = [p.name, f?.name].filter(Boolean).join(' / ');
  return `<div class="req-tab${active ? ' active' : ''}" data-action="switch-tab" data-id="${esc(t.id)}" draggable="true" title="${esc(`${where}\n${r.method} ${r.url}`)}">
      <span class="method-tag m-${esc(methodLabel(r))}">${esc(methodLabel(r))}</span><span class="req-tab-name">${esc(r.name)}</span>${status}
      <button class="req-tab-close" data-action="close-tab" data-id="${esc(t.id)}" title="Close tab (${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+'}W)">${icon('close')}</button></div>`;
}

export function renderTabBar() {
  const el = $('tab-bar');
  el.style.display = S.tabs.length ? '' : 'none';
  el.innerHTML = S.tabs.map(tabHtml).join('') + '<button class="req-tab-new" data-action="new-tab" title="New request">+</button>';
  el.querySelector('.req-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
