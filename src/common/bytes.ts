/**
 * Byte-level helpers shared by every layer of FireSync.
 *
 * Everything here is dependency-free and works identically in a Manifest V3
 * service worker, an extension page, and Node (for the test suite). No Buffer,
 * no Node built-ins.
 */

const HEX_ALPHABET = '0123456789abcdef';

/** UTF-8 encode a string. */
export function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

/** UTF-8 decode bytes. */
export function fromUtf8(input: Uint8Array): string {
  return new TextDecoder().decode(input);
}

/** Lower-case hex encoding. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += HEX_ALPHABET[b >>> 4];
    out += HEX_ALPHABET[b & 0x0f];
  }
  return out;
}

/** Decode hex, tolerating upper case. Throws on odd length or bad digits. */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hex string has odd length: ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at offset ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

/** Standard base64 (with padding). */
export function toB64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so we never blow the argument limit on large payloads.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode standard base64. */
export function fromB64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** URL-safe base64, unpadded — the form Firefox Accounts uses for `kid`. */
export function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode URL-safe base64, padding-optional. */
export function fromB64Url(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/');
  return fromB64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

/** Concatenate byte arrays. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** XOR two equal-length buffers. Used to unwrap kB from wrapKB. */
export function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) {
    throw new Error(`xor length mismatch: ${a.length} vs ${b.length}`);
  }
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] as number) ^ (b[i] as number);
  return out;
}

/**
 * Constant-time comparison. Always compares the full length of the longer
 * input so the timing does not leak where the first difference is.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Constant-time comparison of two hex/ASCII strings. */
export function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqual(utf8(a), utf8(b));
}

/**
 * Cryptographically strong random bytes.
 *
 * `getRandomValues` refuses buffers larger than 65 536 bytes, so fill in
 * chunks. Nothing in FireSync asks for that much entropy today, but the helper
 * is generic and silently throwing on a large request would be a landmine.
 */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const MAX = 65536;
  for (let offset = 0; offset < length; offset += MAX) {
    globalThis.crypto.getRandomValues(out.subarray(offset, Math.min(offset + MAX, length)));
  }
  return out;
}

/**
 * A Sync record id: 12 random bytes, URL-safe base64, no padding — exactly the
 * shape Firefox itself generates, so records FireSync creates are
 * indistinguishable from native ones.
 */
export function newRecordId(): string {
  return toB64Url(randomBytes(12));
}

/** Zero a buffer in place. Best-effort hygiene; JS gives no real guarantees. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}
