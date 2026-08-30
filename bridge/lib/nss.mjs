/**
 * Decrypting a local Firefox profile's saved logins.
 *
 * Firefox keeps logins in `logins.json`, each field encrypted with 3DES-CBC
 * under a key stored in `key4.db`. That key is itself encrypted, with a key
 * derived from the profile's global salt and the user's primary password —
 * which is the empty string when no primary password is set, as on most
 * profiles.
 *
 *   key4.db metadata(id='password').item1  →  globalSalt
 *   key4.db metadata(id='password').item2  →  a PBES2 blob that decrypts to
 *                                             "password-check", proving the
 *                                             primary password is right
 *   key4.db nssPrivate.a11                 →  the same PBES2 scheme, wrapping
 *                                             the 24-byte 3DES key
 *   logins.json encryptedUsername/Password →  3DES-CBC under that key
 *
 * Modern profiles (Firefox 75+) wrap with PBKDF2-SHA256 + AES-256-CBC; older
 * ones use a SHA-1/HMAC construction with 3DES. Both are implemented, because a
 * user importing an old profile is exactly the user who most wants an importer.
 *
 * Everything here runs in the bridge host process, never in the browser.
 */

import { createDecipheriv, createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { at, decodeInteger, decodeOid, parse, unpad } from './der.mjs';

const OID = {
  PBES2: '1.2.840.113549.1.5.13',
  PBKDF2: '1.2.840.113549.1.5.12',
  HMAC_SHA256: '1.2.840.113549.2.9',
  AES256_CBC: '2.16.840.1.101.3.4.1.42',
  DES_EDE3_CBC: '1.2.840.113549.3.7',
  PBE_SHA1_3DES: '1.2.840.113549.1.12.5.1.3',
};

export const PASSWORD_CHECK = 'password-check';

/**
 * Load `node:sqlite` at runtime rather than with a static import.
 *
 * It is listed in `builtinModules` only with its `node:` prefix, which several
 * bundlers strip before deciding a specifier is a builtin — they then try to
 * resolve a package called "sqlite" and fail. `process.getBuiltinModule` exists
 * for exactly this and is invisible to static analysis.
 */
function openSqlite() {
  const sqlite = process.getBuiltinModule?.('node:sqlite');
  if (!sqlite) {
    throw new Error('node:sqlite is unavailable; the bridge needs Node 22.5 or newer');
  }
  return sqlite;
}

export class PrimaryPasswordError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PrimaryPasswordError';
    this.code = code;
  }
}

/**
 * Decode the encryption parameters from one of NSS's PBES2 blobs.
 * Returns `{kind, entrySalt, iterations, keyLength, iv, ciphertext}`.
 */
export function decodeEncryptedItem(der) {
  const root = parse(der);
  const algorithm = at(root, 0);
  const outerOid = decodeOid(at(algorithm, 0).value);
  const ciphertext = at(root, 1).value;

  if (outerOid === OID.PBE_SHA1_3DES) {
    const params = at(algorithm, 1);
    return {
      kind: 'legacy-3des',
      entrySalt: at(params, 0).value,
      iterations: decodeInteger(at(params, 1).value),
      keyLength: 32,
      iv: null,
      ciphertext,
    };
  }

  if (outerOid !== OID.PBES2) {
    throw new Error(`key4.db uses an unsupported algorithm: ${outerOid}`);
  }

  const params = at(algorithm, 1);
  const kdf = at(params, 0);
  if (decodeOid(at(kdf, 0).value) !== OID.PBKDF2) {
    throw new Error('key4.db PBES2 blob does not use PBKDF2');
  }
  const kdfParams = at(kdf, 1);
  const prfOid = kdfParams.children[3]
    ? decodeOid(at(kdfParams, 3, 0).value)
    : OID.HMAC_SHA256;
  if (prfOid !== OID.HMAC_SHA256) {
    throw new Error(`key4.db uses an unsupported PBKDF2 PRF: ${prfOid}`);
  }

  const cipher = at(params, 1);
  const cipherOid = decodeOid(at(cipher, 0).value);
  if (cipherOid !== OID.AES256_CBC) {
    throw new Error(`key4.db uses an unsupported cipher: ${cipherOid}`);
  }

  return {
    kind: 'aes256',
    entrySalt: at(kdfParams, 0).value,
    iterations: decodeInteger(at(kdfParams, 1).value),
    keyLength: decodeInteger(at(kdfParams, 2).value),
    // NSS stores 14 bytes here; the real IV is that prefixed with 0x04 0x0e.
    iv: Buffer.concat([Buffer.from([0x04, 0x0e]), Buffer.from(at(cipher, 1).value)]),
    ciphertext,
  };
}

/** The modern derivation: PBKDF2-SHA256 over SHA-1(globalSalt || password). */
export function deriveAesKey(globalSalt, password, entrySalt, iterations, keyLength) {
  const seed = createHash('sha1')
    .update(Buffer.concat([Buffer.from(globalSalt), Buffer.from(password, 'utf8')]))
    .digest();
  return pbkdf2Sync(seed, Buffer.from(entrySalt), iterations, keyLength, 'sha256');
}

/** The legacy derivation, producing a 24-byte 3DES key and an 8-byte IV. */
export function deriveLegacyKey(globalSalt, password, entrySalt) {
  const salt = Buffer.from(entrySalt);
  const hp = createHash('sha1')
    .update(Buffer.concat([Buffer.from(globalSalt), Buffer.from(password, 'utf8')]))
    .digest();
  const chp = createHash('sha1').update(Buffer.concat([hp, salt])).digest();

  const pes = Buffer.alloc(20);
  salt.copy(pes, 0, 0, Math.min(20, salt.length));

  const k1 = createHmac('sha1', chp).update(Buffer.concat([pes, salt])).digest();
  const tk = createHmac('sha1', chp).update(pes).digest();
  const k2 = createHmac('sha1', chp).update(Buffer.concat([tk, salt])).digest();
  const k = Buffer.concat([k1, k2]);

  return { key: k.subarray(0, 24), iv: k.subarray(k.length - 8) };
}

/** Decrypt one of NSS's encrypted items with the given primary password. */
export function decryptItem(der, globalSalt, password) {
  const item = decodeEncryptedItem(der);

  if (item.kind === 'legacy-3des') {
    const { key, iv } = deriveLegacyKey(globalSalt, password, item.entrySalt);
    return decryptCbc('des-ede3-cbc', key, iv, item.ciphertext, 8);
  }

  const key = deriveAesKey(
    globalSalt,
    password,
    item.entrySalt,
    item.iterations,
    item.keyLength,
  );
  return decryptCbc('aes-256-cbc', key, item.iv, item.ciphertext, 16);
}

function decryptCbc(algorithm, key, iv, ciphertext, blockSize) {
  const decipher = createDecipheriv(algorithm, key, iv);
  decipher.setAutoPadding(false);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext)),
    decipher.final(),
  ]);
  return Buffer.from(unpad(plaintext, blockSize));
}

/**
 * Read the 3DES key out of a `key4.db`.
 *
 * Throws `PrimaryPasswordError` with code `primary-password-required` when the
 * profile is protected and no password was supplied, and
 * `primary-password-wrong` when one was supplied and did not work — the caller
 * needs to tell those two apart to prompt sensibly.
 */
export async function readKey4(databasePath, primaryPassword = '') {
  const db = new (openSqlite().DatabaseSync)(databasePath, { readOnly: true });

  try {
    const metadata = db
      .prepare("SELECT item1, item2 FROM metadata WHERE id = 'password' LIMIT 1")
      .get();
    if (!metadata) throw new Error('key4.db has no password metadata row');

    const globalSalt = Buffer.from(metadata.item1);
    const check = Buffer.from(metadata.item2);

    let verified;
    try {
      verified = decryptItem(check, globalSalt, primaryPassword);
    } catch {
      throw new PrimaryPasswordError(
        primaryPassword
          ? 'that primary password did not decrypt the profile'
          : 'this Firefox profile is protected by a primary password',
        primaryPassword ? 'primary-password-wrong' : 'primary-password-required',
      );
    }
    if (!verified.toString('utf8').startsWith(PASSWORD_CHECK)) {
      throw new PrimaryPasswordError(
        primaryPassword
          ? 'that primary password did not decrypt the profile'
          : 'this Firefox profile is protected by a primary password',
        primaryPassword ? 'primary-password-wrong' : 'primary-password-required',
      );
    }

    const row = db
      .prepare('SELECT a11 FROM nssPrivate WHERE a11 IS NOT NULL LIMIT 1')
      .get();
    if (!row) throw new Error('key4.db holds no private key');

    const unwrapped = decryptItem(Buffer.from(row.a11), globalSalt, primaryPassword);
    if (unwrapped.length < 24) {
      throw new Error(`unwrapped key is ${unwrapped.length} bytes; expected at least 24`);
    }
    return unwrapped.subarray(0, 24);
  } finally {
    db.close();
  }
}

/**
 * Decrypt one `logins.json` field. The value is base64 DER:
 * `SEQUENCE { keyId, SEQUENCE { des-ede3-cbc, iv }, ciphertext }`.
 */
export function decryptLoginField(base64Value, tripleDesKey) {
  const der = Buffer.from(base64Value, 'base64');
  const root = parse(der);

  const cipherOid = decodeOid(at(root, 1, 0).value);
  if (cipherOid !== OID.DES_EDE3_CBC) {
    throw new Error(`logins.json field uses an unexpected cipher: ${cipherOid}`);
  }

  const iv = Buffer.from(at(root, 1, 1).value);
  const ciphertext = Buffer.from(at(root, 2).value);
  return decryptCbc('des-ede3-cbc', tripleDesKey, iv, ciphertext, 8).toString('utf8');
}

/** Whether a `key4.db` needs a primary password, without decrypting anything else. */
export async function requiresPrimaryPassword(databasePath) {
  try {
    await readKey4(databasePath, '');
    return false;
  } catch (error) {
    if (error instanceof PrimaryPasswordError) return true;
    return false;
  }
}
