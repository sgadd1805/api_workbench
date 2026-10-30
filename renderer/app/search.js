// API search (⌘K / Ctrl+K): saved requests in every project plus every operation of every attached
// spec, ranked by where the query words appear.
//
// Item: { kind: 'request', id, projectId, projectName, method, title, path, … }
//     | { kind: 'operation', projectId, projectName, specId, specTitle, opKey, method, title, path, … }
//     | { kind: 'command', title, hint, run } (actions/search.js commandItems)
//     | { kind: 'setting' | 'page', group, title, state, run, keepOpen } (actions/palette.js)

// Field weights: a hit in the name/path counts more than one in a long description.
const WEIGHTS = { title: 5, path: 5, method: 3, operationId: 4, tags: 2, params: 2, folder: 2, group: 2, where: 1, description: 1, keywords: 3 };

export function searchItems(projects, analysisFor) {
  const items = [];
  for (const p of projects) {
    const folders = [{ name: '', requests: p.requests }, ...p.folders];
    for (const f of folders) for (const r of f.requests) {
      items.push({ kind: 'request', id: r.id, projectId: p.id, projectName: p.name, method: r.method, title: r.name, path: r.url, folder: f.name, where: p.name });
    }
    for (const meta of p.specs || []) {
      const a = analysisFor(meta.id); if (!a) continue;
      for (const op of a.operations) {
        items.push({
          kind: 'operation', projectId: p.id, projectName: p.name, specId: meta.id, specTitle: meta.title, opKey: op.key,
          method: op.method, title: op.summary || op.operationId || '', path: op.path, operationId: op.operationId || '',
          tags: op.tags.join(' '), description: op.description || '', deprecated: op.deprecated,
          params: op.parameters.map((x) => x.name).join(' '), where: `${p.name} ${meta.title}`,
        });
      }
    }
  }
  return items;
}

const norm = (s) => String(s || '').toLowerCase();

// → items with { score, snippet } where every query word matched somewhere, best first.
export function searchApi(items, query, limit = 50) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const item of items) {
    let score = 0, ok = true, snippet = '';
    for (const w of words) {
      let best = 0;
      for (const [field, weight] of Object.entries(WEIGHTS)) {
        const text = norm(item[field]);
        if (!text) continue;
        if (field === 'method') { if (text === w) best = Math.max(best, weight * 2); continue; }
        const at = text.indexOf(w);
        if (at < 0) continue;
        // Whole-segment / word-start matches rank above mid-word ones.
        const boundary = at === 0 || /[\s/._{}-]/.test(text[at - 1]);
        best = Math.max(best, weight * (boundary ? 2 : 1));
        if (field === 'description' && !snippet) snippet = excerpt(item.description, at, w.length);
      }
      if (!best) { ok = false; break; }
      score += best;
    }
    if (!ok) continue;
    if (item.deprecated) score -= 1;
    out.push({ ...item, score, snippet });
  }
  return out.sort((a, b) => b.score - a.score || (a.path || '').length - (b.path || '').length).slice(0, limit);
}

function excerpt(text, at, len) {
  const start = Math.max(0, at - 40), end = Math.min(text.length, at + len + 60);
  return (start ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
}
