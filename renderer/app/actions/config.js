// Applying api-client.json from a project's code folder (config.js), noticing when it changes, writing a
// project's setup out as api-client.json, and importing just the requests of one.
import { notify } from '../../shared/notify.js';
import { S, saveDB, currentProject } from '../store.js';
import { applyConfig, linkOperations, exportConfig, configRequestPaths, requestsOnly, summaryText, CONFIG_FILE } from '../config.js';
import { ensureProjectSpecs, specAnalysis } from '../openapi/registry.js';
import { renderAll } from '../views/index.js';
import { attachSpec } from './specs.js';
import { applyAppearance, applyAiSetting } from './layout.js';
import { openModal } from '../modal.js';
import { validateSchema } from '../openapi/schema.js';
import { esc } from '../../shared/html.js';

// Problems against docs/api-client.schema.json (none if the schema can't be loaded).
async function schemaIssues(cfg) {
  try {
    const { default: schema } = await import('../../../docs/api-client.schema.json', { with: { type: 'json' } });
    return validateSchema(schema, cfg, { root: schema }).map((e) => `${e.path || '(top level)'} ${e.message}`);
  } catch { return []; }
}

const api = window.electronAPI;
const pathOf = (p) => (p.codeFolder ? `${p.codeFolder.replace(/[\\/]+$/, '')}/${CONFIG_FILE}` : null);
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h >>> 0); };

// cfg: an already-parsed (partial) config, e.g. the requests chosen by config-import-requests; content is then ''.
async function apply(p, content, codeFolder, { force = false, cfg = null } = {}) {
  if (!cfg) try { cfg = JSON.parse(content); } catch (err) { return notify(`${CONFIG_FILE} isn't valid JSON: ${err.message}`, 'error', 9000); }
  const issues = force ? [] : await schemaIssues(cfg);
  if (issues.length) {
    return openModal({ title: `${CONFIG_FILE} has ${issues.length} problem${issues.length === 1 ? '' : 's'}`, ok: 'Apply anyway', wide: true, fields: [],
      hint: 'Checked against docs/api-client.schema.json. Fields the app doesn\'t know are ignored when applying.',
      html: `<ul class="config-issues">${issues.slice(0, 30).map((i) => `<li><code>${esc(i)}</code></li>`).join('')}</ul>`,
      onOk: () => apply(p, content, codeFolder, { force: true }) });
  }
  let res;
  try { res = applyConfig(cfg, { project: p, codeFolder, adoptCodeFolder: !!content }); } catch (err) { return notify(err.message, 'error'); }
  let attached = 0;
  for (const location of res.specs) if (await attachSpec(res.project, { type: /^https?:/i.test(location) ? 'url' : 'file', location })) attached++;
  if (res.links.length) { await ensureProjectSpecs(res.project); res.warnings.push(...linkOperations(res.project, res.links, specAnalysis)); }
  if (res.accounts.length) { const n = await mergeAccounts(res.accounts); if (n) res.summary['test accounts'] = n; }
  if (res.settings) { applyAppearance(); applyAiSetting(); }
  if (content) res.project.configHash = hash(content); // (requests imported on their own have no file to remember)
  S.projectId = res.project.id; S.projectOpen[res.project.id] = true;
  saveDB(); renderAll();
  notify(`${content ? `Applied ${CONFIG_FILE} to` : 'Imported into'} ${res.project.name}: ${summaryText(res.summary)}${attached ? `, ${attached} spec(s)` : ''}${res.warnings.length ? ` · ${res.warnings.length} warning(s): ${res.warnings[0]}` : ''}`, res.warnings.length ? 'error' : 'info', 9000);
  return res;
}

// Adds Session-toolbar test accounts that aren't there yet (matched by label + environment); passwords
// are entered in the app (Session → Creds → Edit). → number added
async function mergeAccounts(list) {
  const have = await api.accountsList();
  const key = (a) => `${a.label}\u0000${a.env || ''}`;
  const known = new Set(have.map(key));
  const added = list.filter((a) => !known.has(key(a)));
  if (added.length) await api.accountsSave([...have.map(({ id, env, label, user }) => ({ id, env, label, user })), ...added]);
  return added.length;
}

// Offers to apply the project's api-client.json when it exists and changed since it was last applied.
export async function checkConfig(p = currentProject()) {
  const file = p && pathOf(p); if (!file) return;
  const res = await api.readTextFile(file);
  if (!res.ok || !res.exists || hash(res.content) === p.configHash) return;
  notify(`${p.name}: ${CONFIG_FILE} ${p.configHash ? 'changed' : 'found'} in the code folder`, 'info', 12000, { label: 'Apply', run: () => configActions['config-apply']() });
}

export const configActions = {
  async 'config-apply'() {
    const p = currentProject(); if (!p) return notify('Select a project first', 'error');
    const file = pathOf(p); if (!file) return notify('Set the project\'s code folder first (Project settings), or use "Apply a config file…"', 'error', 7000);
    const res = await api.readTextFile(file);
    if (!res.ok) return notify(res.error, 'error');
    if (!res.exists) return notify(`No ${CONFIG_FILE} in ${p.codeFolder} (see docs/CONFIGURING.md for the format)`, 'error', 8000);
    await apply(p, res.content, p.codeFolder);
  },
  async 'config-pick'() {
    const file = await api.openTextFile(); if (!file.ok) { if (!file.canceled) notify(file.error, 'error'); return; }
    const dir = file.filePath.replace(/[\\/][^\\/]*$/, '');
    await apply(currentProject() || null, file.content, dir);
  },
  // The selected project's setup as api-client.json (no secret values), for the repo or a backup.
  'config-export'() {
    const p = currentProject(); if (!p) return notify('Select a project first', 'error');
    openModal({ title: `Export ${p.name} as ${CONFIG_FILE}`, ok: 'Save…', wide: true,
      hint: 'Secret values are never written: secret variables become { "secret": true }, literal tokens and passwords are left out, and so are the cookie jar and certificate passphrases.',
      fields: [{ key: 'extra', label: 'Also include', type: 'checklist', options: [
        { value: 'accounts', label: 'Session test accounts (label, user and environment; no passwords)', checked: true },
        { value: 'settings', label: 'App settings (theme, layout, OpenTelemetry, proxy, AI prompt sections)' }] }],
      onOk: async (v) => {
        const accounts = v.extra.includes('accounts') ? await api.accountsList() : [];
        const { config, warnings } = exportConfig(p, { accounts, settings: v.extra.includes('settings') });
        const saved = await api.saveTextFile(p.codeFolder ? `${p.codeFolder.replace(/[\\/]+$/, '')}/${CONFIG_FILE}` : CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
        if (!saved.ok) { if (!saved.canceled) notify(saved.error, 'error'); return; }
        notify(`Saved ${saved.filePath}${warnings.length ? ` · ${warnings.length} note(s): ${warnings[0]}` : ''}`, 'info', 9000);
      } });
  },
  // Pick requests from an api-client.json and add them to the selected project (nothing else is applied).
  async 'config-import-requests'() {
    const p = currentProject(); if (!p) return notify('Select a project first', 'error');
    const file = await api.openTextFile(); if (!file.ok) { if (!file.canceled) notify(file.error, 'error'); return; }
    let cfg;
    try { cfg = JSON.parse(file.content); } catch (err) { return notify(`Not valid JSON: ${err.message}`, 'error'); }
    const paths = configRequestPaths(cfg || {});
    if (!paths.length) return notify('That file has no requests (folders[].requests or requests)', 'error');
    const dir = file.filePath.replace(/[\\/][^\\/]*$/, '');
    openModal({ title: `Import requests into ${p.name}`, ok: 'Import', wide: true,
      hint: 'Matched by folder and name: existing requests are updated, others are added. Token sources the chosen requests use come too.',
      fields: [{ key: 'pick', label: `Requests in ${file.filePath.split(/[\\/]/).pop()}`, type: 'checklist', options: paths.map((x) => ({ value: x, label: x, checked: true })) }],
      onOk: (v) => { if (v.pick.length) apply(p, '', dir, { force: true, cfg: requestsOnly(cfg, v.pick) }); } });
  },
};
