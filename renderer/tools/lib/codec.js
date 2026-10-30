// Base64 (UTF-8 aware) and JWT decoding.
export const b64enc = (s) => { let bin = ''; new TextEncoder().encode(s).forEach((c) => (bin += String.fromCharCode(c))); return btoa(bin); };

// Accepts base64url and line-wrapped input too.
const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export const b64dec = (s) => new TextDecoder().decode(b64ToBytes(s));

// → { header, payload } or null. Does not verify the signature.
export function decodeJwt(token) {
  try {
    const p = token.trim().split('.');
    if (p.length !== 3) return null;
    const part = (s) => JSON.parse(b64dec(s));
    return { header: part(p[0]), payload: part(p[1]) };
  } catch { return null; }
}
