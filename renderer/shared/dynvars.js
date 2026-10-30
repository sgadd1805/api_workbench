// Dynamic variables: {{$name}} values made when a request is sent, for test data without scripts.
//   {{$uuid}}  {{$timestamp}}  {{$isoNow+1d}}  {{$date-7d}}  {{$randomInt:1:6}}  {{$randomEmail}} …
// Offsets: +/-N followed by s, m, h, d or w. Arguments: :a:b after the name.
// Postman's names ($guid, $isoTimestamp, $randomUUID, $randomBoolean …) work too.
// Within one send, the same expression gives the same value (so {{$uuid}} in a header and the body match).

const FIRST = ['Ann', 'Bo', 'Carla', 'Dev', 'Eli', 'Fatima', 'Gus', 'Hana', 'Ivan', 'Jun', 'Kofi', 'Lena', 'Mateo', 'Nora', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tariq', 'Uma', 'Vik', 'Wren', 'Yara', 'Zed'];
const LAST = ['Abara', 'Becker', 'Chen', 'Diaz', 'Evans', 'Fischer', 'Garcia', 'Haddad', 'Ito', 'Jensen', 'Kowalski', 'Lopez', 'Moreau', 'Nakamura', 'Okafor', 'Patel', 'Quinn', 'Rossi', 'Silva', 'Tanaka', 'Usman', 'Varga', 'Walsh', 'Young', 'Zhou'];
const WORDS = ['amber', 'basil', 'cedar', 'delta', 'ember', 'fjord', 'garnet', 'harbor', 'indigo', 'juniper', 'kestrel', 'lagoon', 'meadow', 'nectar', 'orchid', 'pebble', 'quartz', 'raven', 'saffron', 'thistle', 'umber', 'velvet', 'willow', 'zephyr'];
const CITIES = ['Lisbon', 'Osaka', 'Nairobi', 'Toronto', 'Oslo', 'Lima', 'Pune', 'Leeds', 'Austin', 'Seoul'];

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (list) => list[rnd(list.length)];
const chars = (set, n) => Array.from({ length: n }, () => set[rnd(set.length)]).join('');
const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => (c === 'x' ? rnd(16) : (rnd(4) + 8)).toString(16)));
const UNIT = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

// name → [description, make(args, now)]. now is a Date (with any offset applied).
const GEN = {
  uuid: ['a random UUID', () => uuid()],
  timestamp: ['Unix time in seconds', (_a, now) => String(Math.floor(now / 1000))],
  timestampMs: ['Unix time in milliseconds', (_a, now) => String(+now)],
  isoNow: ['date and time, ISO 8601 (UTC)', (_a, now) => now.toISOString()],
  date: ['date, YYYY-MM-DD (UTC)', (_a, now) => now.toISOString().slice(0, 10)],
  randomInt: ['a whole number, :min:max (default 0–1000)', ([a, b]) => { const lo = int(a, 0), hi = int(b, a === undefined ? 1000 : lo + 1000); return String(lo + rnd(Math.max(1, hi - lo + 1))); }],
  randomBoolean: ['true or false', () => String(Math.random() < 0.5)],
  randomFirstName: ['a first name', () => pick(FIRST)],
  randomLastName: ['a last name', () => pick(LAST)],
  randomFullName: ['first and last name', () => `${pick(FIRST)} ${pick(LAST)}`],
  randomUserName: ['a user name', () => `${pick(FIRST).toLowerCase()}${rnd(1000)}`],
  randomEmail: ['an @example.com address', () => `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${rnd(1000)}@example.com`],
  randomPhone: ['a 555 phone number', () => `+1-555-${String(rnd(1000)).padStart(3, '0')}-${String(rnd(10000)).padStart(4, '0')}`],
  randomWord: ['a word', () => pick(WORDS)],
  randomWords: ['words, :count (default 3)', ([n]) => Array.from({ length: Math.min(50, int(n, 3)) }, () => pick(WORDS)).join(' ')],
  randomCity: ['a city', () => pick(CITIES)],
  randomAlphaNumeric: ['letters and digits, :length (default 8)', ([n]) => chars('abcdefghijklmnopqrstuvwxyz0123456789', Math.min(256, int(n, 8)))],
  randomHex: ['hex digits, :length (default 16)', ([n]) => chars('0123456789abcdef', Math.min(256, int(n, 16)))],
  randomIP: ['an IPv4 address', () => `${1 + rnd(223)}.${rnd(256)}.${rnd(256)}.${1 + rnd(254)}`],
};
const ALIAS = { guid: 'uuid', randomUUID: 'uuid', isoTimestamp: 'isoNow', randomBool: 'randomBoolean', randomUsername: 'randomUserName' };

// "$isoNow+1d" / "$randomInt:1:6" → { name, args, offsetMs } | null
export function parseDynamic(expr) {
  const m = /^\$([A-Za-z]\w*)((?::[\w.-]*)*)([+-]\d+[smhdw])?$/.exec(String(expr).trim());
  if (!m) return null;
  const name = ALIAS[m[1]] || m[1];
  if (!GEN[name]) return null;
  const off = m[3] ? /^([+-])(\d+)([smhdw])$/.exec(m[3]) : null;
  return { name, args: m[2] ? m[2].slice(1).split(':') : [], offsetMs: off ? (off[1] === '-' ? -1 : 1) * +off[2] * UNIT[off[3]] : 0 };
}

export const isDynamic = (expr) => parseDynamic(expr) !== null;

// The value for one expression; cache (a Map per send) keeps repeated expressions equal. → string | undefined
export function dynamicValue(expr, cache = null, now = Date.now()) {
  if (cache?.has(expr)) return cache.get(expr);
  const d = parseDynamic(expr); if (!d) return undefined;
  const v = GEN[d.name][1](d.args, new Date(now + d.offsetMs));
  cache?.set(expr, v);
  return v;
}

// For autocomplete and docs: [{ name: '$uuid', description }]
export const DYNAMIC_VARS = Object.entries(GEN).map(([k, [description]]) => ({ name: '$' + k, description }));

// The {{…}} pattern: environment names, or $dynamic expressions with arguments / offsets.
export const VAR_SOURCE = '\\{\\{\\s*(\\$[A-Za-z]\\w*(?::[\\w.-]*)*(?:[+-]\\d+[smhdw])?|[\\w.-]+)\\s*\\}\\}';
