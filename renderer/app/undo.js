// Deletes happen at once, with an Undo button on the toast instead of a "type DELETE" prompt.
// undoable() snapshots the projects, feature groups and open tabs, runs the change, and Undo puts
// the snapshot back (request ids are kept, so tabs, history and feature groups line up again).
import { notify } from '../shared/notify.js';
import { DB, S, saveDB, findReq } from './store.js';
import { renderAll } from './views/index.js';

export function undoable(message, change) {
  const snap = { projects: structuredClone(DB.projects), features: structuredClone(DB.features), tabs: S.tabs, reqId: S.req?.id, envId: S.envId };
  change();
  saveDB(); renderAll();
  notify(message, 'info', 8000, { label: 'Undo', run: () => {
    DB.projects = snap.projects; DB.features = snap.features;
    S.tabs = snap.tabs.filter((t) => findReq(t.id));
    S.req = (snap.reqId && findReq(snap.reqId)?.r) || null;
    S.envId = snap.envId;
    saveDB(); renderAll();
    notify('Restored');
  } });
}
