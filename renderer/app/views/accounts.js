import { esc } from '../../shared/html.js';
import { S } from '../store.js';
import { icon } from '../../shared/icons.js';

// Accounts page: edits S.accounts (a draft loaded from main/accounts.js), saved with "Save".
export function accountsPageHtml() {
  const draft = S.accounts;
  if (!draft) return '<p class="hint">Loading…</p>';
  const input = (i, field, value, extra = '') => `<input type="text" data-acc-idx="${i}" data-acc-field="${field}" value="${esc(value)}" ${extra}/>`;
  const secret = (a, i, field, saved, label) => `<div class="secret-cell">
      <input type="password" data-acc-idx="${i}" data-acc-field="${field}" value="${esc(a[field] || '')}"
        placeholder="${saved ? '•••••• saved' : label}" autocomplete="new-password"/>
      ${saved ? `<button class="btn-ghost small" data-action="account-forget" data-idx="${i}" data-field="${field}" title="Remove the saved value">forget</button>` : ''}</div>`;
  const rows = draft.map((a, i) => `<div class="account-row">
      ${input(i, 'env', a.env, 'placeholder="env, e.g. staging"')}
      ${input(i, 'label', a.label, 'placeholder="button label"')}
      ${input(i, 'user', a.user, 'placeholder="username / email" spellcheck="false"')}
      ${secret(a, i, 'pass', a.hasPass && !a.clearPass, 'password')}
      ${secret(a, i, 'totp', a.hasTotp && !a.clearTotp, 'TOTP secret (base32, optional)')}
      <button class="btn-ghost small" data-action="account-del" data-idx="${i}" title="Delete account">${icon('close')}</button></div>`).join('');
  return `<div class="page-head"><button class="btn-ghost small" data-action="close-page">${icon('back')} Back</button><h3>Test accounts</h3></div>
    <p class="mb-10 hint">These fill the Creds buttons in the toolbar. Passwords and TOTP secrets stay in the main process
      and are stored in a file only your user account can read; leave a field blank to keep what's saved.</p>
    <div class="account-row account-head hint"><span>Env</span><span>Label</span><span>User</span><span>Password</span><span>TOTP secret</span><span></span></div>
    ${rows || '<p class="my-8 hint">No accounts yet.</p>'}
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn-ghost small" data-action="account-add">+ Account</button>
      <button class="btn-primary small" data-action="accounts-save">Save</button></div>`;
}
