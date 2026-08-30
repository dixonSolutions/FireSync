/**
 * Synthesise a Firefox profile whose plaintext the test already knows.
 *
 * Writes a real `key4.db` (SQLite) and `logins.json` using an encryptor written
 * independently of `bridge/lib/nss.mjs`, so the decryptor is checked against
 * something other than itself.
 */

import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { integer, octet, oid, seq } from './der-encode.mjs';

// See bridge/lib/nss.mjs for why this is not a static import.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

const OID = {
  PBES2: '1.2.840.113549.1.5.13',
  PBKDF2: '1.2.840.113549.1.5.12',
  HMAC_SHA256: '1.2.840.113549.2.9',
  AES256_CBC: '2.16.840.1.101.3.4.1.42',
  DES_EDE3_CBC: '1.2.840.113549.3.7',
  PBE_SHA1_3DES: '1.2.840.113549.1.12.5.1.3',
};

function encrypt(algorithm, key, iv, plaintext) {
  const cipher = createCipheriv(algorithm, key, iv);
  return Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
}

/** Modern wrapping: PBKDF2-SHA256 over SHA-1(globalSalt || password), AES-256-CBC. */
export function wrapAes(globalSalt, password, plaintext, iterations = 10_000) {
  const entrySalt = randomBytes(32);
  const iv14 = randomBytes(14);
  const iv = Buffer.concat([Buffer.from([0x04, 0x0e]), iv14]);

  const seed = createHash('sha1')
    .update(Buffer.concat([globalSalt, Buffer.from(password, 'utf8')]))
    .digest();
  const key = pbkdf2Sync(seed, entrySalt, iterations, 32, 'sha256');

  return seq(
    seq(
      oid(OID.PBES2),
      seq(
        seq(
          oid(OID.PBKDF2),
          seq(octet(entrySalt), integer(iterations), integer(32), seq(oid(OID.HMAC_SHA256))),
        ),
        seq(oid(OID.AES256_CBC), octet(iv14)),
      ),
    ),
    octet(encrypt('aes-256-cbc', key, iv, plaintext)),
  );
}

/** Legacy wrapping: the SHA-1/HMAC construction with 3DES. */
export function wrapLegacy(globalSalt, password, plaintext, iterations = 1) {
  const entrySalt = randomBytes(20);

  const hp = createHash('sha1')
    .update(Buffer.concat([globalSalt, Buffer.from(password, 'utf8')]))
    .digest();
  const chp = createHash('sha1').update(Buffer.concat([hp, entrySalt])).digest();

  const pes = Buffer.alloc(20);
  entrySalt.copy(pes, 0, 0, Math.min(20, entrySalt.length));

  const k1 = createHmac('sha1', chp).update(Buffer.concat([pes, entrySalt])).digest();
  const tk = createHmac('sha1', chp).update(pes).digest();
  const k2 = createHmac('sha1', chp).update(Buffer.concat([tk, entrySalt])).digest();
  const k = Buffer.concat([k1, k2]);

  return seq(
    seq(oid(OID.PBE_SHA1_3DES), seq(octet(entrySalt), integer(iterations))),
    octet(encrypt('des-ede3-cbc', k.subarray(0, 24), k.subarray(k.length - 8), plaintext)),
  );
}

/** Encrypt one `logins.json` field the way Firefox does. */
export function encryptLoginField(tripleDesKey, plaintext, keyId = randomBytes(16)) {
  const iv = randomBytes(8);
  return seq(
    octet(keyId),
    seq(oid(OID.DES_EDE3_CBC), octet(iv)),
    octet(encrypt('des-ede3-cbc', tripleDesKey, iv, plaintext)),
  ).toString('base64');
}

/**
 * Build a complete throwaway profile directory.
 *
 * `logins` is a list of `{origin, username, password, ...}`; everything else is
 * generated. Returns the directory path plus the secrets, so a test can assert
 * on exact values.
 *
 * @param {{
 *   password?: string,
 *   legacy?: boolean,
 *   logins?: Array<{
 *     origin: string, username: string, password: string,
 *     httpRealm?: string | null, formActionOrigin?: string,
 *     usernameField?: string, passwordField?: string,
 *     timeCreated?: number, timeLastUsed?: number,
 *     timePasswordChanged?: number, timesUsed?: number,
 *     corrupt?: 'username',
 *   }>,
 * }} [options]
 */
export function makeProfile({
  password = '',
  legacy = false,
  logins = [{ origin: 'https://example.com', username: 'ada', password: 'hunter2' }],
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'firesync-profile-'));
  const globalSalt = randomBytes(32);
  const tripleDesKey = randomBytes(24);
  const wrap = legacy ? wrapLegacy : wrapAes;

  const db = new DatabaseSync(join(dir, 'key4.db'));
  db.exec('CREATE TABLE metadata (id PRIMARY KEY UNIQUE ON CONFLICT REPLACE, item1, item2)');
  db.exec('CREATE TABLE nssPrivate (id PRIMARY KEY UNIQUE ON CONFLICT REPLACE, a11, a102)');

  db.prepare('INSERT INTO metadata (id, item1, item2) VALUES (?, ?, ?)').run(
    'password',
    globalSalt,
    wrap(globalSalt, password, 'password-check'),
  );
  db.prepare('INSERT INTO nssPrivate (id, a11, a102) VALUES (?, ?, ?)').run(
    1,
    wrap(globalSalt, password, tripleDesKey),
    Buffer.from('f8000000000000000000000000000001', 'hex'),
  );
  db.close();

  writeFileSync(
    join(dir, 'logins.json'),
    JSON.stringify({
      nextId: logins.length + 1,
      logins: logins.map((login, index) => ({
        id: index + 1,
        hostname: login.origin,
        httpRealm: login.httpRealm ?? null,
        formSubmitURL: login.httpRealm ? null : (login.formActionOrigin ?? login.origin),
        usernameField: login.usernameField ?? 'email',
        passwordField: login.passwordField ?? 'pass',
        encryptedUsername:
          login.corrupt === 'username'
            ? 'bm90LWRlcg=='
            : encryptLoginField(tripleDesKey, login.username),
        encryptedPassword: encryptLoginField(tripleDesKey, login.password),
        guid: `{guid-${index}}`,
        encType: 1,
        timeCreated: login.timeCreated ?? 1_600_000_000_000,
        timeLastUsed: login.timeLastUsed ?? 1_600_000_000_000,
        timePasswordChanged: login.timePasswordChanged ?? 1_600_000_000_000,
        timesUsed: login.timesUsed ?? 3,
      })),
    }),
  );

  return { dir, globalSalt, tripleDesKey };
}
