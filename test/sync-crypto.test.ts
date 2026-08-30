import { describe, expect, it } from 'vitest';
import { fromB64, randomBytes, toB64, toHex, utf8 } from '../src/common/bytes.ts';
import { aesCbcEncrypt, hmacSha256 } from '../src/common/crypto.ts';
import {
  bundleFromPair,
  bundleToPair,
  CollectionKeys,
  computePayloadHmac,
  decryptPayload,
  decryptRecord,
  encryptPayload,
  encryptRecord,
  RecordCryptoError,
} from '../src/sync15/crypto.ts';
import type { EncryptedPayload, KeyBundle } from '../src/sync15/crypto.ts';

function newBundle(): KeyBundle {
  return { encKey: randomBytes(32), hmacKey: randomBytes(32) };
}

/**
 * Build an encrypted payload the way the Firefox client does, written
 * independently of `encryptPayload` so the envelope format is genuinely
 * checked rather than merely round-tripped.
 */
async function referenceEncrypt(
  bundle: KeyBundle,
  plaintext: string,
): Promise<EncryptedPayload> {
  const iv = randomBytes(16);
  const raw = await aesCbcEncrypt(bundle.encKey, iv, utf8(plaintext));
  const ciphertext = toB64(raw);
  // Note: the HMAC covers the ASCII of the *base64 text*, not the raw bytes.
  const hmac = toHex(await hmacSha256(bundle.hmacKey, utf8(ciphertext)));
  return { ciphertext, IV: toB64(iv), hmac };
}

describe('key bundles', () => {
  it('round-trips through the [enc, hmac] base64 pair', () => {
    const bundle = newBundle();
    const restored = bundleFromPair(bundleToPair(bundle));
    expect(toHex(restored.encKey)).toBe(toHex(bundle.encKey));
    expect(toHex(restored.hmacKey)).toBe(toHex(bundle.hmacKey));
  });

  it('rejects a pair with the wrong key sizes', () => {
    expect(() => bundleFromPair([toB64(randomBytes(16)), toB64(randomBytes(32))])).toThrow(
      /32\+32 bytes/,
    );
  });
});

describe('payload envelope', () => {
  it('computes the HMAC over the base64 ciphertext text', async () => {
    const bundle = newBundle();
    const payload = await encryptPayload(bundle, '{"hello":"world"}');
    const expected = toHex(await hmacSha256(bundle.hmacKey, utf8(payload.ciphertext)));
    expect(payload.hmac).toBe(expected);

    // The raw-bytes interpretation must NOT match — that is the classic bug.
    const wrong = toHex(await hmacSha256(bundle.hmacKey, fromB64(payload.ciphertext)));
    expect(payload.hmac).not.toBe(wrong);
  });

  it('decrypts a payload produced by an independent implementation', async () => {
    const bundle = newBundle();
    const plaintext = JSON.stringify({ id: 'abc', username: 'user' });
    const payload = await referenceEncrypt(bundle, plaintext);
    expect(await decryptPayload(bundle, payload)).toBe(plaintext);
  });

  it('round-trips through encrypt/decrypt', async () => {
    const bundle = newBundle();
    const plaintext = JSON.stringify({ nested: { a: [1, 2, 3] }, unicode: 'héllo 🔐' });
    expect(await decryptPayload(bundle, await encryptPayload(bundle, plaintext))).toBe(plaintext);
  });

  it('uses a fresh IV for every encryption', async () => {
    const bundle = newBundle();
    const first = await encryptPayload(bundle, 'same');
    const second = await encryptPayload(bundle, 'same');
    expect(first.IV).not.toBe(second.IV);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('rejects a tampered ciphertext before attempting decryption', async () => {
    const bundle = newBundle();
    const payload = await encryptPayload(bundle, '{"a":1}');
    const bytes = fromB64(payload.ciphertext);
    bytes[0] = (bytes[0] as number) ^ 0xff;

    await expect(
      decryptPayload(bundle, { ...payload, ciphertext: toB64(bytes) }),
    ).rejects.toThrow(RecordCryptoError);
  });

  it('rejects a payload whose HMAC was recomputed with the wrong key', async () => {
    const payload = await encryptPayload(newBundle(), '{"a":1}');
    await expect(decryptPayload(newBundle(), payload)).rejects.toThrow(
      /HMAC verification failed/,
    );
  });

  it('accepts an upper-case HMAC, as some clients emit', async () => {
    const bundle = newBundle();
    const payload = await encryptPayload(bundle, '{"a":1}');
    const shouted = { ...payload, hmac: payload.hmac.toUpperCase() };
    await expect(decryptPayload(bundle, shouted)).resolves.toContain('"a"');
  });

  it('rejects an IV of the wrong length', async () => {
    const bundle = newBundle();
    const payload = await encryptPayload(bundle, '{"a":1}');
    const badIv = { ...payload, IV: toB64(randomBytes(8)) };
    badIv.hmac = await computePayloadHmac(bundle.hmacKey, badIv.ciphertext);
    await expect(decryptPayload(bundle, badIv)).rejects.toThrow(/IV must be 16 bytes/);
  });

  it('rejects a payload that is not an envelope at all', async () => {
    await expect(
      decryptPayload(newBundle(), { foo: 'bar' } as unknown as EncryptedPayload),
    ).rejects.toThrow(/not an encrypted Sync envelope/);
  });

  it('reports the record id on failure so a sync can name the bad record', async () => {
    const payload = await encryptPayload(newBundle(), '{}');
    await expect(decryptPayload(newBundle(), payload, 'record-42')).rejects.toMatchObject({
      recordId: 'record-42',
    });
  });

  it('surfaces non-JSON plaintext as a crypto error, not a raw SyntaxError', async () => {
    const bundle = newBundle();
    const payload = await encryptPayload(bundle, 'not json at all');
    await expect(decryptRecord(bundle, payload)).rejects.toThrow(/not JSON/);
  });

  it('encryptRecord/decryptRecord preserve object shape', async () => {
    const bundle = newBundle();
    const record = { id: 'x', hostname: 'https://example.com', timesUsed: 3 };
    expect(await decryptRecord(bundle, await encryptRecord(bundle, record))).toEqual(record);
  });
});

describe('CollectionKeys', () => {
  it('decrypts a crypto/keys record with the oldsync bundle', async () => {
    const syncBundle = newBundle();
    const defaultBundle = newBundle();
    const record = { id: 'keys', collection: 'crypto', default: bundleToPair(defaultBundle) };

    const payload = await encryptRecord(syncBundle, record);
    const keys = await CollectionKeys.fromEncrypted(syncBundle, payload);

    expect(toHex(keys.defaultBundle.encKey)).toBe(toHex(defaultBundle.encKey));
    expect(toHex(keys.forCollection('passwords').encKey)).toBe(toHex(defaultBundle.encKey));
  });

  it('honours a per-collection override', () => {
    const defaultBundle = newBundle();
    const passwordsBundle = newBundle();
    const keys = CollectionKeys.fromRecord({
      default: bundleToPair(defaultBundle),
      collections: { passwords: bundleToPair(passwordsBundle) },
    });

    expect(toHex(keys.forCollection('passwords').encKey)).toBe(toHex(passwordsBundle.encKey));
    expect(toHex(keys.forCollection('addresses').encKey)).toBe(toHex(defaultBundle.encKey));
  });

  it('rejects a crypto/keys record without a default bundle', () => {
    expect(() => CollectionKeys.fromRecord({ default: [] as unknown as [string, string] })).toThrow(
      /"default" bundle/,
    );
  });

  it('round-trips through toRecord', () => {
    const keys = CollectionKeys.generate();
    const restored = CollectionKeys.fromRecord(keys.toRecord());
    expect(toHex(restored.defaultBundle.hmacKey)).toBe(toHex(keys.defaultBundle.hmacKey));
  });

  it('generates independent 32-byte keys', () => {
    const keys = CollectionKeys.generate();
    expect(keys.defaultBundle.encKey).toHaveLength(32);
    expect(keys.defaultBundle.hmacKey).toHaveLength(32);
    expect(toHex(keys.defaultBundle.encKey)).not.toBe(toHex(keys.defaultBundle.hmacKey));
  });
});
