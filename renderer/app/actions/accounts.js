// Accounts page (main/accounts.js stores them). Edits go into the S.accounts draft until Save.
import { notify } from '../../shared/notify.js';
import { emit } from '../../shared/bus.js';
import { S } from '../store.js';
import { renderPage } from '../views/index.js';
import { setPage } from './core.js';

export async function openAccounts() {
  S.accounts = null;
  setPage('accounts');
  S.accounts = (await window.electronAPI.accountsList()).map((a) => ({ ...a, pass: '', totp: '' }));
  renderPage();
}

export const accountActions = {
  'account-add'() { S.accounts.push({ env: '', label: '', user: '', pass: '', totp: '' }); renderPage(); },
  'account-del'(d) { S.accounts.splice(+d.idx, 1); renderPage(); },
  'account-forget'(d) {
    const a = S.accounts[+d.idx];
    if (d.field === 'pass') a.clearPass = true; else a.clearTotp = true;
    a[d.field] = ''; renderPage();
  },
  async 'accounts-save'() {
    const res = await window.electronAPI.accountsSave(S.accounts.map(({ hasPass, hasTotp, ...a }) => a));
    if (!res.ok) return notify('Could not save: ' + res.error, 'error', 8000);
    S.accounts = res.accounts.map((a) => ({ ...a, pass: '', totp: '' }));
    renderPage(); emit('accounts-changed'); notify('Accounts saved');
  },
};

// 'input' on an accounts page field.
export function onAccountInput(el) {
  const a = S.accounts?.[+el.dataset.accIdx]; if (!a) return;
  a[el.dataset.accField] = el.value;
}
