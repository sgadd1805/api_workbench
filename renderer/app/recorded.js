// Mock routes from traffic recorded by the intercepting proxy (Proxy page → Mock from traffic): the
// responses one host gave, served again by main/mock.js, e.g. to stand in for a downstream service you
// can't run locally.
const SKIP_HEADERS = /^(content-length|content-encoding|transfer-encoding|connection|keep-alive|date|set-cookie|strict-transport-security|alt-svc)$/i;
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24}|(?=.*\d)[A-Za-z0-9_-]{16,})$/i;

const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };

// Hosts in the traffic, most exchanges first. → [{ host, count }]
export function recordedHosts(exchanges) {
  const n = new Map();
  for (const x of exchanges) { if (x.error || x.tunnel) continue; const h = hostOf(x.url); if (h) n.set(h, (n.get(h) || 0) + 1); }
  return [...n].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

// "/pets/7/photos/9f2c…" → "/pets/{id}/photos/{id2}" (numbers, UUIDs, Mongo ids, long tokens)
export function generalizePath(path) {
  let n = 0;
  return path.split('/').map((seg) => (seg && ID_SEGMENT.test(decodeURIComponent(seg)) ? `{id${++n === 1 ? '' : n}}` : seg)).join('/');
}

// exchanges: newest first (as the Proxy page keeps them). → routes for main/mock.js, the latest response
// per route as its default and every recorded status available.
export function recordedRoutes(exchanges, { host, generalize = true } = {}) {
  const routes = new Map();
  for (const x of [...exchanges].reverse()) {
    if (x.error || x.tunnel || !x.status || hostOf(x.url) !== host) continue;
    let path; try { path = new URL(x.url).pathname; } catch { continue; }
    if (generalize) path = generalizePath(path);
    const key = `${x.method} ${path}`;
    const route = routes.get(key) || { method: x.method, path, responses: {}, count: 0 };
    const headers = Object.fromEntries(Object.entries(x.responseHeaders || {}).filter(([k]) => !SKIP_HEADERS.test(k) && !/^content-type$/i.test(k)));
    const contentType = Object.entries(x.responseHeaders || {}).find(([k]) => /^content-type$/i.test(k))?.[1] || null;
    route.responses[String(x.status)] = x.response?.binary
      ? { contentType, bodyBase64: x.response.bodyBase64, headers }
      : { contentType, body: x.response?.body ?? '', headers };
    route.defaultCode = String(x.status);
    route.count++;
    routes.set(key, route);
  }
  return [...routes.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
