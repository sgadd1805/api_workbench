// Project → Save / Load requests as files in the code folder (repo.js), and auto-sync wiring.
import { notify } from '../../shared/notify.js';
import { saveDB, currentProject, onAfterSave } from '../store.js';
import { saveToRepo, loadFromRepo, scheduleAutoSync, updateWatches, repoDir } from '../repo.js';
import { renderAll } from '../views/index.js';
import { openModal } from '../modal.js';

async function reload(p) {
  const s = await loadFromRepo(p); if (!s) return;
  saveDB(); renderAll();
  notify(`Loaded from ${repoDir(p)}: ${s.added} new, ${s.updated} updated, ${s.removed} removed${s.envVars ? `, ${s.envVars} new variables` : ''}`, 'info', 7000);
}

export const refreshRepoWatches = () => updateWatches(reload);

export function initRepoSync() {
  onAfterSave(scheduleAutoSync);
  refreshRepoWatches();
}

export const repoActions = {
  async 'repo-save'() {
    const p = currentProject(); if (!p) return;
    const res = await saveToRepo(p); if (!res) return;
    saveDB();
    notify(`Saved ${res.files} request file(s) to ${repoDir(p)} (${res.written} written, ${res.removed} removed). Commit them to share.`, 'info', 7000);
  },
  'repo-load'() {
    const p = currentProject(); if (!p) return;
    if (!p.codeFolder) return notify('Set the project\'s code folder first (Project settings)', 'error');
    openModal({ title: 'Load requests from the repo?', ok: 'Load', fields: [],
      hint: `Reads ${repoDir(p)}. Requests in the files replace their copies here (local secrets are kept); new ones are added; ones deleted from the repo since the last sync are removed. Requests you haven't saved to the repo yet stay.`,
      onOk: () => reload(p) });
  },
};
