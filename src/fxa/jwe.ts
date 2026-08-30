/**
 * Just enough JOSE to decrypt a Firefox Accounts scoped-key bundle.
 *
 * FxA returns `keys_jwe`: a compact JWE with `alg: "ECDH-ES"` (direct key
 * agreement, so the encrypted-key segment is empty) and `enc: "A256GCM"`,
 * encrypted to the ephemeral P-256 public key we sent as `keys_jwk`.
 *
 * Pulling in a full JOSE library for one algorithm pair would add a large
 * dependency to a security-critical bundle, so this implements exactly the two
 * algorithms FxA uses and refuses everything else.
 *
 * References: RFC 7516 (JWE), RFC 7518 §4.6 (ECDH-ES), NIST SP 800-56A §5.8.1
 * (the Concat KDF).
 */

import { concat, fromB64Url, fromUtf8, utf8 } from '../common/bytes.ts';
import {
  aesGcmDecrypt,
  ecdhDeriveBits,
  importEcdhPublicJwk,
  sha256,
} from '../common/crypto.ts';

export interface JweHeader {
  alg: string;
  enc: string;
  epk?: JsonWebKey;
  apu?: string;
  apv?: string;
  kid?: string;
}

/** Big-endian uint32 length prefix, as the Concat KDF requires. */
function lengthPrefixed(data: Uint8Array): Uint8Array {
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, data.length, false);
  return concat(prefix, data);
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

/**
 * NIST SP 800-56A Concat KDF with SHA-256, single round (all our key sizes are
 * <= 256 bits, so `reps` is always 1).
 */
export async function concatKdf(
  sharedSecret: Uint8Array,
  keyBitLength: number,
  algorithmId: string,
  partyUInfo: Uint8Array,
  partyVInfo: Uint8Array,
): Promise<Uint8Array> {
  if (keyBitLength > 256) {
    throw new Error('concatKdf: only single-round derivation is implemented');
  }
  const input = concat(
    uint32(1),
    sharedSecret,
    lengthPrefixed(utf8(algorithmId)),
    lengthPrefixed(partyUInfo),
    lengthPrefixed(partyVInfo),
    uint32(keyBitLength),
  );
  return (await sha256(input)).slice(0, keyBitLength / 8);
}

/** Parse a compact JWE into its five segments. */
export function parseCompactJwe(compact: string): {
  header: JweHeader;
  protectedB64: string;
  encryptedKey: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
} {
  const parts = compact.split('.');
  if (parts.length !== 5) {
    throw new Error(`malformed compact JWE: expected 5 segments, got ${parts.length}`);
  }
  const [protectedB64, encryptedKeyB64, ivB64, ciphertextB64, tagB64] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const segment = (value: string, name: string): Uint8Array => {
    try {
      return fromB64Url(value);
    } catch {
      throw new Error(`malformed compact JWE: ${name} is not valid base64url`);
    }
  };

  let header: JweHeader;
  try {
    header = JSON.parse(fromUtf8(segment(protectedB64, 'the protected header'))) as JweHeader;
  } catch (cause) {
    throw new Error(`malformed compact JWE: unreadable protected header (${String(cause)})`);
  }

  return {
    header,
    protectedB64,
    encryptedKey: segment(encryptedKeyB64, 'the encrypted key'),
    iv: segment(ivB64, 'the IV'),
    ciphertext: segment(ciphertextB64, 'the ciphertext'),
    tag: segment(tagB64, 'the tag'),
  };
}

/**
 * Decrypt an `ECDH-ES` + `A256GCM` compact JWE with our ephemeral private key.
 * Returns the plaintext string.
 */
export async function decryptEcdhEsJwe(
  compact: string,
  privateKey: CryptoKey,
): Promise<string> {
  const { header, protectedB64, encryptedKey, iv, ciphertext, tag } = parseCompactJwe(compact);

  if (header.alg !== 'ECDH-ES') {
    throw new Error(`unsupported JWE alg: ${header.alg} (expected ECDH-ES)`);
  }
  if (header.enc !== 'A256GCM') {
    throw new Error(`unsupported JWE enc: ${header.enc} (expected A256GCM)`);
  }
  if (encryptedKey.length !== 0) {
    throw new Error('ECDH-ES is direct key agreement; encrypted key must be empty');
  }
  if (!header.epk) {
    throw new Error('JWE header is missing the ephemeral public key (epk)');
  }
  if (iv.length !== 12) {
    throw new Error(`A256GCM requires a 12-byte IV, got ${iv.length}`);
  }

  const epk = await importEcdhPublicJwk(header.epk);
  const sharedSecret = await ecdhDeriveBits(privateKey, epk, 32);

  // With alg=ECDH-ES (direct), AlgorithmID is the *enc* value.
  const cek = await concatKdf(
    sharedSecret,
    256,
    header.enc,
    header.apu ? fromB64Url(header.apu) : new Uint8Array(0),
    header.apv ? fromB64Url(header.apv) : new Uint8Array(0),
  );

  // WebCrypto expects ciphertext||tag, and the AAD is the ASCII protected header.
  const plaintext = await aesGcmDecrypt(cek, iv, concat(ciphertext, tag), utf8(protectedB64));
  return fromUtf8(plaintext);
}
