// {{variable}} substitution. Variables come from the project's active environment
// (Postman uses the same syntax, so imported collections keep working); {{$dynamic}} ones are made
// when sending (shared/dynvars.js).
import { VAR_SOURCE, dynamicValue } from '../shared/dynvars.js';

const VAR = new RegExp(VAR_SOURCE, 'g');

// Enabled variables of the active environment → { name: value }.
export function activeVars(p) {
  const env = p?.envs?.find((e) => e.id === p.activeEnv);
  return Object.fromEntries((env?.vars || []).filter((v) => v.on && v.k).map((v) => [v.k, v.v]));
}

// Replaces known {{names}}; unknown ones are left as written and reported via `missing`.
// dyn: a Map shared by one send, so each {{$expression}} gets one value throughout the request.
export function resolve(str, vars, missing, dyn = new Map()) {
  return String(str ?? '').replace(VAR, (m, name) => {
    if (Object.hasOwn(vars, name)) return vars[name];
    if (name.startsWith('$')) { const v = dynamicValue(name, dyn); if (v !== undefined) return v; }
    missing?.add(name);
    return m;
  });
}

// encodeURIComponent that leaves {{variables}} intact, for building query strings / form bodies.
export function encodeKeepingVars(s) {
  let out = '', last = 0;
  for (const m of String(s).matchAll(VAR)) {
    out += encodeURIComponent(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + encodeURIComponent(String(s).slice(last));
}
