/**
 * Vault encryption at rest.
 *
 * `chrome.storage.local` is a plaintext file on disk. Anything FireSync
 * persists there — the credential set, the OAuth refresh token, kSync — is
 * sealed with a key derived from a passphrase the user sets, which is
 * deliberately NOT the Mozilla account password: a password change at Mozilla
 * must not orphan the local vault, and a compromised vault must not hand over
 * the account.
 *
 * Each sealed blob carries additional authenticated data naming its slot, so a
 * blob cannot be moved from one storage key to another.
 */

import { fromB64, randomBytes, toB64, utf8 } from '../common/bytes.ts';
import { aesGcmDecrypt, aesGcmEncrypt, pbkdf2 } from '../common/crypto.ts';

/** OWASP's 2023 floor for PBKDF2-HMAC-SHA256. Raised, never lowered. */
export const DEFAULT_KDF_ITERATIONS = 600_000;
export const VAULT_FORMAT_VERSION = 1;

export interface KdfParams {
  algorithm: 'PBKDF2-SHA256';
  iterations: number;
  /** base64, 16 bytes. */
  salt: string;
}

export interface SealedBlob {
  v: number;
  alg: 'A256GCM';
  /** base64 12-byte nonce. */
  iv: string;
  /** base64 ciphertext||tag. */
  ct: string;
}

export class VaultLockedError extends Error {
  constructor(message = 'the vault is locked') {
    super(message);
    this.name = 'VaultLockedError';
  }
}

export class WrongPassphraseError extends Error {
  constructor(message = 'incorrect passphrase') {
    super(message);
    this.name = 'WrongPassphraseError';
  }
}

/** Fresh KDF parameters for a brand new vault. */
export function newKdfParams(iterations = DEFAULT_KDF_ITERATIONS): KdfParams {
  return { algorithm: 'PBKDF2-SHA256', iterations, salt: toB64(randomBytes(16)) };
}

/** Stretch a passphrase into the 256-bit vault key. */
export async function deriveVaultKey(
  passphrase: string,
  params: KdfParams,
): Promise<Uint8Array> {
  if (params.algorithm !== 'PBKDF2-SHA256') {
    throw new Error(`unsupported vault KDF: ${params.algorithm}`);
  }
  if (params.iterations < 100_000) {
    throw new Error(`refusing to derive a vault key with only ${params.iterations} iterations`);
  }
  return pbkdf2(utf8(passphrase.normalize('NFKC')), fromB64(params.salt), params.iterations, 32);
}

/** Encrypt a JSON-serialisable value into a sealed blob bound to `slot`. */
export async function seal(key: Uint8Array, value: unknown, slot: string): Promise<SealedBlob> {
  const iv = randomBytes(12);
  const ciphertext = await aesGcmEncrypt(key, iv, utf8(JSON.stringify(value)), utf8(slot));
  return { v: VAULT_FORMAT_VERSION, alg: 'A256GCM', iv: toB64(iv), ct: toB64(ciphertext) };
}

/** Decrypt a sealed blob. Throws `WrongPassphraseError` on tag failure. */
export async function unseal<T>(key: Uint8Array, blob: SealedBlob, slot: string): Promise<T> {
  if (blob?.alg !== 'A256GCM') throw new Error(`unsupported vault blob algorithm: ${blob?.alg}`);
  if (blob.v > VAULT_FORMAT_VERSION) {
    throw new Error(`vault blob version ${blob.v} is newer than this build understands`);
  }
  let plaintext: Uint8Array;
  try {
    plaintext = await aesGcmDecrypt(key, fromB64(blob.iv), fromB64(blob.ct), utf8(slot));
  } catch {
    throw new WrongPassphraseError();
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** Storage slot names. Also the AAD, which is why they are centralised. */
export const SLOT = {
  vault: 'firesync.vault.v1',
  tokens: 'firesync.tokens.v1',
  verifier: 'firesync.verifier.v1',
} as const;

/** A short blob whose only job is to confirm a passphrase quickly. */
export async function makeVerifier(key: Uint8Array): Promise<SealedBlob> {
  return seal(key, { ok: true, at: 0 }, SLOT.verifier);
}

/** Check a candidate key against the stored verifier. */
export async function checkVerifier(key: Uint8Array, verifier: SealedBlob): Promise<boolean> {
  try {
    const value = await unseal<{ ok: boolean }>(key, verifier, SLOT.verifier);
    return value.ok === true;
  } catch {
    return false;
  }
}
