// MD5 of a string's UTF-8 bytes (Web Crypto has no MD5).
export function md5(str) {
  function safeAdd(x, y) { const l = (x & 0xFFFF) + (y & 0xFFFF); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xFFFF); }
  function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cmn(q, a, b, x, s, t) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  const ff = (a, b, c, d, x, s, t) => cmn((b & c) | (~b & d), a, b, x, s, t);
  const gg = (a, b, c, d, x, s, t) => cmn((b & d) | (c & ~d), a, b, x, s, t);
  const hh = (a, b, c, d, x, s, t) => cmn(b ^ c ^ d, a, b, x, s, t);
  const ii = (a, b, c, d, x, s, t) => cmn(c ^ (b | ~d), a, b, x, s, t);
  const bytes = new TextEncoder().encode(str);
  const l = bytes.length, nw = (((l + 8) >> 6) + 1) * 16, x = new Array(nw).fill(0);
  for (let i = 0; i < l; i++) x[i >> 2] |= bytes[i] << ((i % 4) * 8);
  x[l >> 2] |= 0x80 << ((l % 4) * 8);
  x[nw - 2] = l * 8;
  const K = []; for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  let a = 0x67452301, b = 0xEFCDAB89 | 0, c = 0x98BADCFE | 0, d = 0x10325476;
  for (let k = 0; k < nw; k += 16) {
    const A = a, B = b, C = c, D = d;
    for (let i = 0; i < 64; i++) {
      let g, fn;
      if (i < 16) { fn = ff; g = i; } else if (i < 32) { fn = gg; g = (5 * i + 1) % 16; }
      else if (i < 48) { fn = hh; g = (3 * i + 5) % 16; } else { fn = ii; g = (7 * i) % 16; }
      const s = SHIFTS[(i >> 4) * 4 + (i % 4)];
      const t = fn(a, b, c, d, x[k + g], s, K[i]);
      a = d; d = c; c = b; b = t;
    }
    a = safeAdd(a, A); b = safeAdd(b, B); c = safeAdd(c, C); d = safeAdd(d, D);
  }
  const hex = (v) => { let s = ''; for (let i = 0; i < 4; i++) s += ('0' + ((v >>> (i * 8)) & 0xFF).toString(16)).slice(-2); return s; };
  return hex(a) + hex(b) + hex(c) + hex(d);
}
