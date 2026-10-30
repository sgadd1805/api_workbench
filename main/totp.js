'use strict';
// RFC 6238 TOTP (SHA-1, 6 digits, 30 s step) from a base32 secret. Runs in the main process so
// stored secrets never reach the renderer.
const crypto = require('crypto');

const PERIOD = 30;

function base32Decode(str) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  str = str.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, val = 0; const bytes = [];
  for (const ch of str) {
    const idx = alpha.indexOf(ch);
    if (idx < 0) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(bytes);
}

// → 6-digit code, or null when the secret has no base32 characters.
function generateTotp(secret, now = Date.now()) {
  const key = base32Decode(secret || '');
  if (!key.length) return null;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / PERIOD)));
  const sig = crypto.createHmac('sha1', key).update(counter).digest();
  const off = sig[19] & 0xf;
  const code = ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

const secondsLeft = (now = Date.now()) => PERIOD - (Math.floor(now / 1000) % PERIOD);

module.exports = { base32Decode, generateTotp, secondsLeft };
