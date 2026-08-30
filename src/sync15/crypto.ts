/**
 * Sync 1.5 record encryption ("storage format 5").
 *
 * Every non-`meta` record on the server is a BSO whose `payload` is a JSON
 * string of the form:
 *
 *   { "ciphertext": base64, "IV": base64, "hmac": hex }
 *
 * The HMAC is computed over the ASCII bytes of the *base64 text* of the
 * ciphertext, not over the raw ciphertext bytes. That detail is the single
 * most common reason a hand-rolled Sync client fails to validate records, so
 * it is asserted directly in `test/sync-crypto.test.ts`.
 *
 * Reference: https://mozilla-services.readthedocs.io/en/latest/sync/storageformat5.html
 */

import {
  fromB64,
  fromUtf8,
  randomBytes,
  timingSafeEqualString,
  toB64,
  toHex,
  utf8,
} from '../common/bytes.ts';
import { aesCbcDecrypt, aesCbcEncrypt, hmacSha256 } from '../common/crypto.ts';

/** An AES-256-CBC key plus its HMAC-SHA256 key. */
export interface KeyBundle {
  encKey: Uint8Array;
  hmacKey: Uint8Array;
}

/** The JSON envelope stored in a BSO's `payload` field. */
export interface EncryptedPayload {
  ciphertext: string;
  IV: string;
  hmac: string;
}

/** Raised when a record fails HMAC verification or cannot be decrypted. */
export class RecordCryptoError extends Error {
  constructor(message: string, readonly recordId?: string) {
    super(message);
    this.name = 'RecordCryptoError';
  }
}

/** Build a key bundle from the `[encKeyB64, hmacKeyB64]` pair in crypto/keys. */
export function bundleFromPair(pair: readonly [string, string]): KeyBundle {
  const encKey = fromB64(pair[0]);
  const hmacKey = fromB64(pair[1]);
  if (encKey.length !== 32 || hmacKey.length !== 32) {
    throw new RecordCryptoError(
      `key bundle must be 32+32 bytes, got ${encKey.length}+${hmacKey.length}`,
    );
  }
  return { encKey, hmacKey };
}

/** Serialize a key bundle back to the `[b64, b64]` pair form. */
export function bundleToPair(bundle: KeyBundle): [string, string] {
  return [toB64(bundle.encKey), toB64(bundle.hmacKey)];
}

/** The HMAC value for a given ciphertext, as lower-case hex. */
export async function computePayloadHmac(
  hmacKey: Uint8Array,
  ciphertextB64: string,
): Promise<string> {
  return toHex(await hmacSha256(hmacKey, utf8(ciphertextB64)));
}

/** Verify + decrypt a payload envelope, returning the plaintext JSON string. */
export async function decryptPayload(
  bundle: KeyBundle,
  payload: EncryptedPayload,
  recordId?: string,
): Promise<string> {
  if (!payload || typeof payload.ciphertext !== 'string' || typeof payload.IV !== 'string') {
    throw new RecordCryptoError('payload is not an encrypted Sync envelope', recordId);
  }
  const expected = await computePayloadHmac(bundle.hmacKey, payload.ciphertext);
  if (!timingSafeEqualString(expected, (payload.hmac ?? '').toLowerCase())) {
    throw new RecordCryptoError('HMAC verification failed', recordId);
  }
  const iv = fromB64(payload.IV);
  if (iv.length !== 16) {
    throw new RecordCryptoError(`IV must be 16 bytes, got ${iv.length}`, recordId);
  }
  let plaintext: Uint8Array;
  try {
    plaintext = await aesCbcDecrypt(bundle.encKey, iv, fromB64(payload.ciphertext));
  } catch (cause) {
    throw new RecordCryptoError(`AES-CBC decryption failed: ${String(cause)}`, recordId);
  }
  return fromUtf8(plaintext);
}

/** Encrypt a plaintext JSON string into a payload envelope. */
export async function encryptPayload(
  bundle: KeyBundle,
  plaintext: string,
  iv: Uint8Array = randomBytes(16),
): Promise<EncryptedPayload> {
  if (iv.length !== 16) throw new RecordCryptoError(`IV must be 16 bytes, got ${iv.length}`);
  const ciphertext = toB64(await aesCbcEncrypt(bundle.encKey, iv, utf8(plaintext)));
  return {
    ciphertext,
    IV: toB64(iv),
    hmac: await computePayloadHmac(bundle.hmacKey, ciphertext),
  };
}

/** Decrypt and JSON-parse in one step. */
export async function decryptRecord<T>(
  bundle: KeyBundle,
  payload: EncryptedPayload,
  recordId?: string,
): Promise<T> {
  const json = await decryptPayload(bundle, payload, recordId);
  try {
    return JSON.parse(json) as T;
  } catch (cause) {
    throw new RecordCryptoError(`decrypted payload is not JSON: ${String(cause)}`, recordId);
  }
}

/** JSON-stringify and encrypt in one step. */
export async function encryptRecord(
  bundle: KeyBundle,
  value: unknown,
  iv?: Uint8Array,
): Promise<EncryptedPayload> {
  return encryptPayload(bundle, JSON.stringify(value), iv);
}

/** The decrypted shape of the `crypto/keys` record. */
export interface CryptoKeysRecord {
  id?: string;
  collection?: string;
  default: [string, string];
  collections?: Record<string, [string, string]>;
}

/**
 * The per-account key ring: a default bundle plus optional per-collection
 * overrides. Firefox has never shipped an override in practice, but the format
 * allows them and ignoring that would silently corrupt data if it ever did.
 */
export class CollectionKeys {
  constructor(
    readonly defaultBundle: KeyBundle,
    readonly collectionBundles: Record<string, KeyBundle> = {},
  ) {}

  /** Decrypt a fetched `crypto/keys` payload with the oldsync key bundle. */
  static async fromEncrypted(
    syncKeyBundle: KeyBundle,
    payload: EncryptedPayload,
  ): Promise<CollectionKeys> {
    const record = await decryptRecord<CryptoKeysRecord>(syncKeyBundle, payload, 'crypto/keys');
    return CollectionKeys.fromRecord(record);
  }

  static fromRecord(record: CryptoKeysRecord): CollectionKeys {
    if (!Array.isArray(record.default) || record.default.length !== 2) {
      throw new RecordCryptoError('crypto/keys is missing a usable "default" bundle');
    }
    const overrides: Record<string, KeyBundle> = {};
    for (const [name, pair] of Object.entries(record.collections ?? {})) {
      if (Array.isArray(pair) && pair.length === 2) {
        overrides[name] = bundleFromPair(pair as [string, string]);
      }
    }
    return new CollectionKeys(bundleFromPair(record.default), overrides);
  }

  /** Mint a brand new key ring — only used when initialising an empty account. */
  static generate(): CollectionKeys {
    return new CollectionKeys({ encKey: randomBytes(32), hmacKey: randomBytes(32) });
  }

  /** The bundle to use for a collection: its override, else the default. */
  forCollection(name: string): KeyBundle {
    return this.collectionBundles[name] ?? this.defaultBundle;
  }

  toRecord(): CryptoKeysRecord {
    const collections: Record<string, [string, string]> = {};
    for (const [name, bundle] of Object.entries(this.collectionBundles)) {
      collections[name] = bundleToPair(bundle);
    }
    return { id: 'keys', collection: 'crypto', default: bundleToPair(this.defaultBundle), collections };
  }
}
