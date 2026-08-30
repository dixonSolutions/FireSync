/**
 * WebCrypto wrappers used by both the Firefox Accounts (onepw / OAuth) layer
 * and the Sync 1.5 record layer.
 *
 * HKDF is implemented by hand on top of HMAC rather than via
 * `crypto.subtle.deriveBits({name: 'HKDF'})` for one specific reason: Firefox
 * Accounts derives every key with an EMPTY salt, and hand-rolling the RFC 5869
 * extract step (`HMAC(salt || zeros(hashLen), ikm)`) removes any dependence on
 * how a given engine treats a zero-length salt. It is 15 lines and it is
 * covered by the RFC 5869 test vectors in `test/crypto.test.ts`.
 */

import { concat } from './bytes.ts';

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

export const SHA256_LEN = 32;

/** SHA-256 digest. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', data as BufferSource));
}

/** HMAC-SHA-256. */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await subtle().sign('HMAC', k, data as BufferSource));
}

/** RFC 5869 extract step. An empty salt becomes `hashLen` zero bytes. */
export async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  const effectiveSalt = salt.length > 0 ? salt : new Uint8Array(SHA256_LEN);
  return hmacSha256(effectiveSalt, ikm);
}

/** RFC 5869 expand step. */
export async function hkdfExpand(
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const blocks = Math.ceil(length / SHA256_LEN);
  if (blocks > 255) throw new Error(`HKDF: cannot expand to ${length} bytes`);
  const out = new Uint8Array(length);
  let previous: Uint8Array = new Uint8Array(0);
  let offset = 0;
  for (let i = 1; i <= blocks; i++) {
    previous = await hmacSha256(prk, concat(previous, info, new Uint8Array([i])));
    const take = Math.min(SHA256_LEN, length - offset);
    out.set(previous.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

/** RFC 5869 HKDF-SHA256. */
export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  return hkdfExpand(await hkdfExtract(salt, ikm), info, length);
}

/** PBKDF2-HMAC-SHA256. */
export async function pbkdf2(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  length: number,
): Promise<Uint8Array> {
  const key = await subtle().importKey('raw', password as BufferSource, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** AES-256-CBC encrypt with PKCS#7 padding (what Sync 1.5 records use). */
export async function aesCbcEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key as BufferSource, 'AES-CBC', false, ['encrypt']);
  const ct = await subtle().encrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, plaintext as BufferSource);
  return new Uint8Array(ct);
}

/** AES-256-CBC decrypt. */
export async function aesCbcDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key as BufferSource, 'AES-CBC', false, ['decrypt']);
  const pt = await subtle().decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, ciphertext as BufferSource);
  return new Uint8Array(pt);
}

/** AES-256-GCM encrypt — used for the local vault, never for Sync records. */
export async function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt']);
  const params: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 };
  if (aad) params.additionalData = aad as BufferSource;
  return new Uint8Array(await subtle().encrypt(params, k, plaintext as BufferSource));
}

/** AES-256-GCM decrypt. Throws if the tag does not verify. */
export async function aesGcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
  const params: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 };
  if (aad) params.additionalData = aad as BufferSource;
  return new Uint8Array(await subtle().decrypt(params, k, ciphertext as BufferSource));
}

/** Generate an ephemeral P-256 ECDH key pair for the FxA scoped-key flow. */
export async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]) as Promise<CryptoKeyPair>;
}

/** Export a key as JWK. */
export async function exportJwk(key: CryptoKey): Promise<JsonWebKey> {
  return subtle().exportKey('jwk', key);
}

/** Import a P-256 private key from JWK. */
export async function importEcdhPrivateJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
}

/** Import a P-256 public key from JWK. */
export async function importEcdhPublicJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

/** ECDH shared secret (Z) as raw bytes. */
export async function ecdhDeriveBits(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  length = 32,
): Promise<Uint8Array> {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, length * 8);
  return new Uint8Array(bits);
}
