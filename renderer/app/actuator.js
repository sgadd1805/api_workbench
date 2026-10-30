// Spring Boot Actuator: reading /actuator/health, /env, /mappings and /loggers, and turning mappings into
// requests. Pure functions over the endpoints' JSON (Spring Boot 2 and 3 shapes); the page is
// views/actuator.js + actions/actuator.js.

// /actuator/health → [{ name, status, depth, details }] (components nested by depth)
export function healthRows(health, name = 'application', depth = 0, out = []) {
  if (!health || typeof health !== 'object') return out;
  out.push({ name, status: health.status || 'UNKNOWN', depth, details: health.details || null });
  for (const [k, v] of Object.entries(health.components || health.details?.components || {})) healthRows(v, k, depth + 1, out);
  return out;
}

// /actuator/env → [{ name, value, source, origin }] with the winning value first per property (sources are in precedence order).
export function envRows(env) {
  const rows = [], seen = new Set();
  for (const src of env?.propertySources || []) {
    for (const [name, p] of Object.entries(src.properties || {})) {
      rows.push({ name, value: p?.value === undefined ? '' : String(p.value), source: src.name, origin: p?.origin || '', overridden: seen.has(name) });
      seen.add(name);
    }
  }
  return rows;
}

// /actuator/mappings → [{ methods, path, handler, controller, produces, consumes, params }] for servlet (MVC) and reactive (WebFlux) apps.
export function mappingRows(mappings) {
  const out = [];
  for (const ctx of Object.values(mappings?.contexts || {})) {
    const groups = [...Object.values(ctx.mappings?.dispatcherServlets || {}), ...Object.values(ctx.mappings?.dispatcherHandlers || {})];
    for (const list of groups) {
      for (const m of list || []) {
        const c = m.details?.requestMappingConditions;
        if (!c) continue;
        const handler = m.details?.handlerMethod ? `${m.details.handlerMethod.className}#${m.details.handlerMethod.name}` : m.handler || '';
        const controller = (m.details?.handlerMethod?.className || handler.split('#')[0] || '').split('.').pop();
        for (const path of c.patterns || []) {
          out.push({ methods: (c.methods || []).length ? c.methods : ['GET'], path, handler, controller,
            produces: (c.produces || []).map((x) => x.mediaType), consumes: (c.consumes || []).map((x) => x.mediaType),
            params: (c.params || []).map((x) => x.name || x), anyMethod: !(c.methods || []).length });
        }
      }
    }
  }
  const seen = new Set();
  return out.filter((r) => { const k = r.methods.join(',') + ' ' + r.path; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.path.localeCompare(b.path));
}

// Framework endpoints most people don't want as requests.
export const isInternalMapping = (m) => /^\/(actuator|error)(\/|$)|^\/\*\*|^\/webjars|^\/swagger|^\/v3\/api-docs/.test(m.path) || /^org\.springframework\.(boot|web\.servlet\.resource)/.test(m.handler);

// One mapping → request fields (store.js newReq), against {{baseUrl}}; path variables become {{variables}}.
export function requestForMapping(m, method) {
  const url = '{{baseUrl}}' + m.path.replace(/\{([^}:]+)(?::[^}]*)?\}/g, '{{$1}}').replace(/\/\*\*$/, '');
  const json = m.consumes.some((c) => /json/.test(c)) || (['POST', 'PUT', 'PATCH'].includes(method) && !m.consumes.length);
  return {
    name: `${method} ${m.path}`, method, url,
    headers: m.produces.length ? [{ k: 'Accept', v: m.produces[0], on: true }] : [],
    body: json && ['POST', 'PUT', 'PATCH'].includes(method) ? { type: 'json', text: '{}', form: [] } : { type: 'none', text: '', form: [] },
  };
}

export const pathVariables = (path) => [...path.matchAll(/\{([^}:]+)(?::[^}]*)?\}/g)].map((m) => m[1]);

// /actuator/loggers → { levels, rows: [{ name, configured, effective }] } (ROOT first)
export function loggerRows(loggers) {
  const rows = Object.entries(loggers?.loggers || {}).map(([name, l]) => ({ name, configured: l.configuredLevel || null, effective: l.effectiveLevel || null }));
  rows.sort((a, b) => (a.name === 'ROOT' ? -1 : b.name === 'ROOT' ? 1 : a.name.localeCompare(b.name)));
  // Level names come from the server: only plain words are kept (they're also escaped where shown).
  const levels = (Array.isArray(loggers?.levels) ? loggers.levels : []).filter((l) => typeof l === 'string' && /^[A-Za-z]{1,16}$/.test(l));
  return { levels: levels.length ? levels : ['OFF', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'], rows };
}

// The Actuator base URL for a URL like http://localhost:8080/api/v1 (scheme + host + /actuator).
export function actuatorBaseFor(url) {
  try { const u = new URL(url); return `${u.origin}/actuator`; } catch { return ''; }
}
