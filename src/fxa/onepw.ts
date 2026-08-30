/**
 * The Firefox Accounts "onepw" key hierarchy.
 *
 * Reference: https://mozilla.github.io/ecosystem-platform/reference/onepw-protocol
 *
 *   quickStretchedPW = PBKDF2-SHA256(password, KWE("quickStretch", email), 1000, 32)
 *   authPW           = HKDF(quickStretchedPW, "", KW("authPW"),     32)
 *   unwrapBKey       = HKDF(quickStretchedPW, "", KW("unwrapBkey"), 32)
 *
 *   tokenId|reqHMACkey|requestKey = HKDF(keyFetchToken, "", KW("keyFetchToken"), 96)
 *   respHMACkey|respXORkey        = HKDF(requestKey,    "", KW("account/keys"),  96)
 *   kA|wrapKB                     = bundle[0..64] XOR respXORkey
 *   kB                            = wrapKB XOR unwrapBKey
 *
 *   kSync                         = HKDF(kB, "", KW("oldsync"), 64)
 *
 * Every salt is empty; HKDF therefore extracts with 32 zero bytes (RFC 5869).
 */

import { concat, fromHex, timingSafeEqual, toB64Url, toHex, utf8, xor } from '../common/bytes.ts';
import { hkdf, hmacSha256, pbkdf2, sha256 } from '../common/crypto.ts';

export const FXA_NAMESPACE = 'identity.mozilla.com/picl/v1/';
export const QUICK_STRETCH_ITERATIONS = 1000;
export const OLDSYNC_SCOPE = 'https://identity.mozilla.com/apps/oldsync';

/** Key-wrapping context string: `identity.mozilla.com/picl/v1/<name>`. */
export function KW(name: string): Uint8Array {
  return utf8(FXA_NAMESPACE + name);
}

/** Key-wrapping context string with an email suffix. */
export function KWE(name: string, email: string): Uint8Array {
  return utf8(`${FXA_NAMESPACE}${name}:${email}`);
}

export interface LoginCredentials {
  /** PBKDF2 output; keep only as long as you need authPW/unwrapBKey. */
  quickStretchedPW: Uint8Array;
  /** Sent to the auth server in place of the password. */
  authPW: Uint8Array;
  /** Never leaves the device — unwraps wrapKB into kB. */
  unwrapBKey: Uint8Array;
}

/** PBKDF2 stretch of the user's password. Deliberately the only slow step. */
export async function quickStretch(email: string, password: string): Promise<Uint8Array> {
  return pbkdf2(utf8(password), KWE('quickStretch', email), QUICK_STRETCH_ITERATIONS, 32);
}

/** Derive authPW + unwrapBKey from an email/password pair. */
export async function deriveLoginCredentials(
  email: string,
  password: string,
): Promise<LoginCredentials> {
  const quickStretchedPW = await quickStretch(email, password);
  const [authPW, unwrapBKey] = await Promise.all([
    hkdf(quickStretchedPW, new Uint8Array(0), KW('authPW'), 32),
    hkdf(quickStretchedPW, new Uint8Array(0), KW('unwrapBkey'), 32),
  ]);
  return { quickStretchedPW, authPW, unwrapBKey };
}

export interface TokenCredentials {
  /** Hawk id, hex-encoded. */
  tokenId: Uint8Array;
  /** Hawk key. */
  reqHMACkey: Uint8Array;
  /** Only present for keyFetchToken — used to unbundle /account/keys. */
  requestKey?: Uint8Array;
}

/** tokenId | reqHMACkey | requestKey from a keyFetchToken. */
export async function deriveKeyFetchCredentials(
  keyFetchToken: Uint8Array,
): Promise<Required<TokenCredentials>> {
  const material = await hkdf(keyFetchToken, new Uint8Array(0), KW('keyFetchToken'), 96);
  return {
    tokenId: material.slice(0, 32),
    reqHMACkey: material.slice(32, 64),
    requestKey: material.slice(64, 96),
  };
}

/** tokenId | reqHMACkey from a sessionToken. */
export async function deriveSessionCredentials(
  sessionToken: Uint8Array,
): Promise<TokenCredentials> {
  const material = await hkdf(sessionToken, new Uint8Array(0), KW('sessionToken'), 64);
  return { tokenId: material.slice(0, 32), reqHMACkey: material.slice(32, 64) };
}

export interface AccountKeys {
  kA: Uint8Array;
  kB: Uint8Array;
}

/**
 * Verify and unbundle the 96-byte response of `GET /account/keys`.
 *
 * Throws if the HMAC does not verify — that means either a corrupted response
 * or an active attacker, and in both cases we must not proceed.
 */
export async function unbundleAccountKeys(
  requestKey: Uint8Array,
  bundle: Uint8Array,
  unwrapBKey: Uint8Array,
): Promise<AccountKeys> {
  if (bundle.length !== 96) {
    throw new Error(`/account/keys bundle must be 96 bytes, got ${bundle.length}`);
  }
  const material = await hkdf(requestKey, new Uint8Array(0), KW('account/keys'), 96);
  const respHMACkey = material.slice(0, 32);
  const respXORkey = material.slice(32, 96);

  const ciphertext = bundle.slice(0, 64);
  const mac = bundle.slice(64, 96);
  const expected = await hmacSha256(respHMACkey, ciphertext);
  if (!timingSafeEqual(expected, mac)) {
    throw new Error('/account/keys HMAC verification failed');
  }

  const plaintext = xor(ciphertext, respXORkey);
  const kA = plaintext.slice(0, 32);
  const wrapKB = plaintext.slice(32, 64);
  return { kA, kB: xor(wrapKB, unwrapBKey) };
}

/** Convenience wrapper taking the hex bundle straight off the wire. */
export async function unbundleAccountKeysHex(
  requestKey: Uint8Array,
  bundleHex: string,
  unwrapBKey: Uint8Array,
): Promise<AccountKeys> {
  return unbundleAccountKeys(requestKey, fromHex(bundleHex), unwrapBKey);
}

export interface SyncKeyMaterial {
  /** The full 64-byte oldsync scoped key. */
  kSync: Uint8Array;
  /** First 32 bytes — AES-256-CBC key for the `crypto/keys` record. */
  encKey: Uint8Array;
  /** Last 32 bytes — HMAC-SHA256 key for the `crypto/keys` record. */
  hmacKey: Uint8Array;
}

/** kSync = HKDF(kB, "", KW("oldsync"), 64). */
export async function deriveSyncKeys(kB: Uint8Array): Promise<SyncKeyMaterial> {
  const kSync = await hkdf(kB, new Uint8Array(0), KW('oldsync'), 64);
  return { kSync, encKey: kSync.slice(0, 32), hmacKey: kSync.slice(32, 64) };
}

/** Split a 64-byte kSync obtained directly from a scoped-key JWE. */
export function splitKSync(kSync: Uint8Array): SyncKeyMaterial {
  if (kSync.length !== 64) throw new Error(`kSync must be 64 bytes, got ${kSync.length}`);
  return { kSync, encKey: kSync.slice(0, 32), hmacKey: kSync.slice(32, 64) };
}

/**
 * The legacy `X-Client-State` header value: hex of the first 16 bytes of
 * SHA-256(kB). Still emitted by some deployments; kept for completeness.
 */
export async function deriveClientStateHex(kB: Uint8Array): Promise<string> {
  return toHex((await sha256(kB)).slice(0, 16));
}

/** The `kid` fingerprint half: base64url of the first 16 bytes of SHA-256(kB). */
export async function deriveClientStateB64Url(kB: Uint8Array): Promise<string> {
  return toB64Url((await sha256(kB)).slice(0, 16));
}

/**
 * The `X-KeyID` header the token server expects:
 * `<keyRotationTimestamp>-<base64url(SHA256(kB)[0:16])>`.
 */
export async function deriveKeyId(kB: Uint8Array, keyRotationTimestamp: number): Promise<string> {
  return `${keyRotationTimestamp}-${await deriveClientStateB64Url(kB)}`;
}

/** Concatenate the pieces of a Hawk id the way FxA expects them (hex). */
export function hawkIdFromTokenId(tokenId: Uint8Array): string {
  return toHex(tokenId);
}

/** Re-export for callers that want to build their own contexts. */
export const internals = { concat };
