import { describe, expect, it } from 'vitest';
import { concat, fromB64Url, randomBytes, toHex, utf8, xor } from '../src/common/bytes.ts';
import { hkdf, hmacSha256, pbkdf2, sha256 } from '../src/common/crypto.ts';
import {
  deriveClientStateB64Url,
  deriveKeyFetchCredentials,
  deriveKeyId,
  deriveLoginCredentials,
  deriveSessionCredentials,
  deriveSyncKeys,
  KW,
  KWE,
  OLDSYNC_SCOPE,
  quickStretch,
  splitKSync,
  unbundleAccountKeys,
} from '../src/fxa/onepw.ts';

const EMAIL = 'andre@example.org';
const PASSWORD = 'passwoerd';

describe('context strings', () => {
  it('namespaces every key with the FxA prefix', () => {
    expect(new TextDecoder().decode(KW('authPW'))).toBe(
      'identity.mozilla.com/picl/v1/authPW',
    );
    expect(new TextDecoder().decode(KWE('quickStretch', EMAIL))).toBe(
      `identity.mozilla.com/picl/v1/quickStretch:${EMAIL}`,
    );
  });

  it('uses the documented oldsync scope', () => {
    expect(OLDSYNC_SCOPE).toBe('https://identity.mozilla.com/apps/oldsync');
  });
});

describe('quickStretch', () => {
  it('is PBKDF2-SHA256 with 1000 iterations over the email-salted context', async () => {
    const ours = await quickStretch(EMAIL, PASSWORD);
    const reference = await pbkdf2(
      utf8(PASSWORD),
      utf8(`identity.mozilla.com/picl/v1/quickStretch:${EMAIL}`),
      1000,
      32,
    );
    expect(toHex(ours)).toBe(toHex(reference));
    expect(ours).toHaveLength(32);
  });

  it('is salted by email, so the same password differs per account', async () => {
    const a = await quickStretch('a@example.org', PASSWORD);
    const b = await quickStretch('b@example.org', PASSWORD);
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('handles non-ASCII emails and passwords byte-for-byte', async () => {
    const stretched = await quickStretch('andré@example.org', 'pässwörd');
    const reference = await pbkdf2(
      utf8('pässwörd'),
      utf8('identity.mozilla.com/picl/v1/quickStretch:andré@example.org'),
      1000,
      32,
    );
    expect(toHex(stretched)).toBe(toHex(reference));
  });
});

describe('deriveLoginCredentials', () => {
  it('derives authPW and unwrapBKey from the stretched password', async () => {
    const creds = await deriveLoginCredentials(EMAIL, PASSWORD);
    const stretched = await quickStretch(EMAIL, PASSWORD);

    expect(toHex(creds.quickStretchedPW)).toBe(toHex(stretched));
    expect(toHex(creds.authPW)).toBe(
      toHex(await hkdf(stretched, new Uint8Array(0), KW('authPW'), 32)),
    );
    expect(toHex(creds.unwrapBKey)).toBe(
      toHex(await hkdf(stretched, new Uint8Array(0), KW('unwrapBkey'), 32)),
    );
  });

  it('never lets authPW equal unwrapBKey', async () => {
    const creds = await deriveLoginCredentials(EMAIL, PASSWORD);
    expect(toHex(creds.authPW)).not.toBe(toHex(creds.unwrapBKey));
  });
});

describe('token credentials', () => {
  it('splits a keyFetchToken into three 32-byte keys', async () => {
    const token = randomBytes(32);
    const creds = await deriveKeyFetchCredentials(token);
    expect(creds.tokenId).toHaveLength(32);
    expect(creds.reqHMACkey).toHaveLength(32);
    expect(creds.requestKey).toHaveLength(32);

    const material = await hkdf(token, new Uint8Array(0), KW('keyFetchToken'), 96);
    expect(toHex(concat(creds.tokenId, creds.reqHMACkey, creds.requestKey))).toBe(
      toHex(material),
    );
  });

  it('splits a sessionToken into two 32-byte keys', async () => {
    const token = randomBytes(32);
    const creds = await deriveSessionCredentials(token);
    const material = await hkdf(token, new Uint8Array(0), KW('sessionToken'), 64);
    expect(toHex(concat(creds.tokenId, creds.reqHMACkey))).toBe(toHex(material));
    expect(creds.requestKey).toBeUndefined();
  });

  it('derives different material for session and keyFetch tokens', async () => {
    const token = randomBytes(32);
    const session = await deriveSessionCredentials(token);
    const keyFetch = await deriveKeyFetchCredentials(token);
    expect(toHex(session.tokenId)).not.toBe(toHex(keyFetch.tokenId));
  });
});

/**
 * Build a `/account/keys` bundle the way the auth server does. Written
 * independently of the production unbundler so the test is a real check.
 */
async function buildAccountKeysBundle(
  requestKey: Uint8Array,
  kA: Uint8Array,
  wrapKB: Uint8Array,
): Promise<Uint8Array> {
  const material = await hkdf(requestKey, new Uint8Array(0), KW('account/keys'), 96);
  const respHMACkey = material.slice(0, 32);
  const respXORkey = material.slice(32, 96);
  const ciphertext = xor(concat(kA, wrapKB), respXORkey);
  const mac = await hmacSha256(respHMACkey, ciphertext);
  return concat(ciphertext, mac);
}

describe('unbundleAccountKeys', () => {
  it('recovers kA and kB from a well-formed bundle', async () => {
    const requestKey = randomBytes(32);
    const unwrapBKey = randomBytes(32);
    const kA = randomBytes(32);
    const kB = randomBytes(32);
    const wrapKB = xor(kB, unwrapBKey);

    const bundle = await buildAccountKeysBundle(requestKey, kA, wrapKB);
    const keys = await unbundleAccountKeys(requestKey, bundle, unwrapBKey);

    expect(toHex(keys.kA)).toBe(toHex(kA));
    expect(toHex(keys.kB)).toBe(toHex(kB));
  });

  it('rejects a bundle whose HMAC does not verify', async () => {
    const requestKey = randomBytes(32);
    const unwrapBKey = randomBytes(32);
    const bundle = await buildAccountKeysBundle(requestKey, randomBytes(32), randomBytes(32));
    bundle[10] = (bundle[10] as number) ^ 0xff;

    await expect(unbundleAccountKeys(requestKey, bundle, unwrapBKey)).rejects.toThrow(
      /HMAC verification failed/,
    );
  });

  it('rejects a bundle of the wrong length', async () => {
    await expect(
      unbundleAccountKeys(randomBytes(32), randomBytes(64), randomBytes(32)),
    ).rejects.toThrow(/must be 96 bytes/);
  });

  it('rejects a bundle signed with a different requestKey', async () => {
    const bundle = await buildAccountKeysBundle(
      randomBytes(32),
      randomBytes(32),
      randomBytes(32),
    );
    await expect(
      unbundleAccountKeys(randomBytes(32), bundle, randomBytes(32)),
    ).rejects.toThrow(/HMAC verification failed/);
  });
});

describe('sync key derivation', () => {
  it('derives a 64-byte oldsync key split into enc + hmac halves', async () => {
    const kB = randomBytes(32);
    const keys = await deriveSyncKeys(kB);

    expect(keys.kSync).toHaveLength(64);
    expect(keys.encKey).toHaveLength(32);
    expect(keys.hmacKey).toHaveLength(32);
    expect(toHex(concat(keys.encKey, keys.hmacKey))).toBe(toHex(keys.kSync));

    const reference = await hkdf(kB, new Uint8Array(0), KW('oldsync'), 64);
    expect(toHex(keys.kSync)).toBe(toHex(reference));
  });

  it('splitKSync agrees with deriveSyncKeys', async () => {
    const kB = randomBytes(32);
    const derived = await deriveSyncKeys(kB);
    const split = splitKSync(derived.kSync);
    expect(toHex(split.encKey)).toBe(toHex(derived.encKey));
    expect(toHex(split.hmacKey)).toBe(toHex(derived.hmacKey));
  });

  it('splitKSync rejects a key of the wrong length', () => {
    expect(() => splitKSync(randomBytes(32))).toThrow(/must be 64 bytes/);
  });
});

describe('X-KeyID', () => {
  it('is the rotation timestamp joined to the base64url kB fingerprint', async () => {
    const kB = randomBytes(32);
    const fingerprint = await deriveClientStateB64Url(kB);
    const keyId = await deriveKeyId(kB, 1510628805);

    expect(keyId).toBe(`1510628805-${fingerprint}`);
    expect(fingerprint).not.toMatch(/[+/=]/);
    expect(fromB64Url(fingerprint)).toHaveLength(16);
    expect(toHex(fromB64Url(fingerprint))).toBe(toHex((await sha256(kB)).slice(0, 16)));
  });
});
