// Back up everything to one file, and restore chosen parts of a backup (backup.js).
import { notify } from '../../shared/notify.js';
import { DB, S, saveDB } from '../store.js';
import { buildBackup, parseBackup, backupContents, restoreBackup, filesWanted, historyToRestore, encryptBackup, decryptBackup, isEncryptedBackup } from '../backup.js';
import { summaryText } from '../config.js';
import { cacheSpec } from '../openapi/registry.js';
import { loadHistory, historyEntries } from '../history.js';
import { openModal } from '../modal.js';
import { renderAll } from '../views/index.js';
import { applyAppearance, applyAiSetting } from './layout.js';

const api = window.electronAPI;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function createBackup({ includeSecrets, includeHistory, includeFiles, password }) {
  notify('Collecting the backup…');
  const specs = {};
  for (const meta of DB.projects.flatMap((p) => p.specs)) {
    const res = await api.specStoreLoad(meta.id);
    if (res.ok) specs[meta.id] = res.doc;
  }
  const accounts = await api.accountsBackup(includeSecrets);
  const history = includeHistory ? await api.historyLoad() : null;
  let files = {}, missing = [], skipped = [];
  if (includeFiles) {
    const read = await api.backupReadFiles(filesWanted(DB.projects));
    if (read.ok) ({ files, missing, skipped } = read); else notify('Request files were left out: ' + read.error, 'error', 8000);
  }
  const backup = buildBackup({ specs, accounts, history, files, includeSecrets });
  const day = backup.createdAt.slice(0, 10);
  if (password) notify('Encrypting the backup…');
  const content = password ? JSON.stringify(await encryptBackup(backup, password)) : JSON.stringify(backup, null, 1);
  const saved = await api.saveTextFile(`api-workbench-backup-${day}${password ? '.encrypted' : ''}.json`, content);
  if (!saved.ok) { if (!saved.canceled) notify(saved.error, 'error'); return; }
  const notes = [missing.length && `${plural(missing.length, 'file')} not found`, skipped.length && `${plural(skipped.length, 'file')} too large`].filter(Boolean);
  notify(`Backed up ${plural(DB.projects.length, 'project')}, ${plural(Object.keys(specs).length, 'spec')}, ${plural(Object.keys(files).length, 'file')}${includeSecrets ? ' (with secrets)' : ''}${password ? ', encrypted with your password,' : ''} to ${saved.filePath}${notes.length ? ` · ${notes.join(', ')}` : ''}`, notes.length ? 'error' : 'info', 10000);
}

async function restore(b, v) {
  const parts = new Set(v.parts);
  let files = { moved: {}, root: '' };
  if (parts.has('files') && Object.keys(b.files || {}).length) {
    const res = await api.backupWriteFiles(b.files);
    if (res.ok) files = res; else notify('Files were not restored: ' + res.error, 'error', 8000);
  }
  const { summary, specDocs, idMap } = restoreBackup(b, {
    projects: v.projects, sameName: v.sameName,
    tokenSources: parts.has('tokenSources'), notes: parts.has('notes'), features: parts.has('features'), settings: parts.has('settings'),
  }, files);
  for (const { id, doc } of specDocs) { const res = await api.specStoreSave(id, doc); if (res.ok) cacheSpec(id, doc); }
  if (specDocs.length) summary.specs = specDocs.length;
  if (parts.has('accounts') && b.accounts?.length) { const res = await api.accountsRestore(b.accounts); if (res.ok && res.added) summary['test accounts'] = res.added; }
  if (parts.has('history') && b.history?.length) {
    const entries = historyToRestore(b, idMap, historyEntries());
    for (const e of entries) await api.historyAppend(e);
    await loadHistory();
    if (entries.length) summary['history entries'] = entries.length;
  }
  const moved = Object.keys(files.moved).length;
  if (moved) summary['files restored to the app folder'] = moved;
  if (parts.has('settings')) { applyAppearance(); applyAiSetting(); }
  S.projectId = DB.projects.at(-1)?.id ?? S.projectId;
  saveDB(); renderAll();
  notify(`Restored: ${summaryText(summary)}${b.secrets ? '' : '. Secrets weren\'t in this backup: enter them in Environments, Project settings and Session → Creds.'}`, 'info', 12000);
}

export const backupActions = {
  'backup-create'() {
    openModal({ title: 'Back up everything', ok: 'Save backup…', wide: true,
      hint: 'One JSON file with all projects (environments, folders, requests, tasks, log sources), features, notes, token sources, app settings, attached specs and Session test accounts. Restore it with Import → Restore from backup.',
      fields: [{ key: 'opts', label: 'Include', type: 'checklist', options: [
        { value: 'files', label: 'Files requests use: .proto files (with their imports), certificates and keys', checked: true },
        { value: 'history', label: 'History (the last 200 sends, credentials already redacted)' },
        { value: 'secrets', label: 'Secrets: tokens, passwords, secret variables, cookies, test-account passwords. Protect the file with a password below.' }] },
        { key: 'password', label: 'Password (encrypts the whole file with AES-256; leave empty for a readable file)', type: 'password' },
        { key: 'confirm', label: 'Password again', type: 'password' }],
      onOk: (v) => {
        if (v.password !== v.confirm) return notify('The two passwords differ: nothing was saved', 'error', 7000);
        if (v.password && v.password.length < 8) return notify('Use a password of at least 8 characters: nothing was saved', 'error', 7000);
        if (v.opts.includes('secrets') && !v.password) notify('This backup holds your secrets in readable form: keep it private', 'error', 9000);
        createBackup({ includeSecrets: v.opts.includes('secrets'), includeHistory: v.opts.includes('history'), includeFiles: v.opts.includes('files'), password: v.password });
      } });
  },
  async 'backup-restore'() {
    const file = await api.openTextFile();
    if (!file.ok) { if (!file.canceled) notify(file.error, 'error'); return; }
    if (!isEncryptedBackup(file.content)) return chooseWhatToRestore(file.content);
    openModal({ title: 'This backup is password-protected', ok: 'Unlock', fields: [{ key: 'password', label: 'Password', type: 'password' }],
      onOk: async (v) => {
        let text;
        try { text = await decryptBackup(file.content, v.password); } catch (err) { return notify(err.message, 'error', 8000); }
        chooseWhatToRestore(text);
      } });
  },
};

function chooseWhatToRestore(text) {
  let b;
  try { b = parseBackup(text); } catch (err) { return notify(err.message, 'error', 8000); }
  const c = backupContents(b);
  if (!c.projects.length && !c.tokenSources && !c.notes) return notify('That backup is empty', 'error');
  const part = (value, label, n, checked = true) => (n ? [{ value, label: `${label} (${n === true ? 'yes' : n})`, checked }] : []);
  openModal({ title: `Restore backup from ${new Date(c.createdAt).toLocaleString()}`, ok: 'Restore', wide: true,
    hint: `Restored projects get new ids, so nothing you have is overwritten unless you choose Replace.${c.secrets ? ' This backup includes secrets.' : ' This backup has no secrets: you\'ll enter tokens and passwords again.'}`,
    fields: [
      { key: 'projects', label: 'Projects', type: 'checklist', options: c.projects.map((p) => ({ value: p.id, label: `${p.name} · ${plural(p.requests, 'request')}${p.exists ? ' · a project with this name exists' : ''}`, checked: true })) },
      { key: 'sameName', label: 'When a project with the same name exists', type: 'select', value: 'keep',
        options: [{ value: 'keep', label: 'Keep both (the restored one is named "… (restored)")' }, { value: 'replace', label: 'Replace it (its notes are kept)' }] },
      { key: 'parts', label: 'Also restore', type: 'checklist', options: [
        ...part('tokenSources', 'Token sources (same name: replaced)', c.tokenSources),
        ...part('features', 'Feature groups for the restored requests', c.features),
        ...part('notes', 'Notes', c.notes),
        ...part('accounts', 'Session test accounts (same label: updated)', c.accounts),
        ...part('files', 'Files requests use (only ones missing on this computer; copied into the app\'s folder)', c.files),
        ...part('history', 'History', c.history, false),
        ...part('settings', 'App settings (theme, layout, AI, proxy, OpenTelemetry)', c.settings, false)] }],
    onOk: (v) => restore(b, v) });
}
