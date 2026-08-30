import { describe, expect, it } from 'vitest';
import {
  concat,
  fromB64,
  fromB64Url,
  fromHex,
  fromUtf8,
  newRecordId,
  randomBytes,
  timingSafeEqual,
  toB64,
  toB64Url,
  toHex,
  utf8,
  xor,
} from '../src/common/bytes.ts';
import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  aesGcmDecrypt,
  aesGcmEncrypt,
  hkdf,
  hmacSha256,
  pbkdf2,
  sha256,
} from '../src/common/crypto.ts';

describe('bytes helpers', () => {
  it('round-trips hex', () => {
    const bytes = randomBytes(64);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  it('encodes hex in lower case with leading zeros', () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xff, 0xa0]))).toBe('000fffa0');
  });

  it('rejects malformed hex', () => {
    expect(() => fromHex('abc')).toThrow(/odd length/);
    expect(() => fromHex('zz')).toThrow(/invalid hex/);
  });

  it('round-trips standard and url-safe base64', () => {
    for (const len of [0, 1, 2, 3, 16, 31, 32, 64, 1000]) {
      const bytes = randomBytes(len);
      expect(fromB64(toB64(bytes))).toEqual(bytes);
      expect(fromB64Url(toB64Url(bytes))).toEqual(bytes);
    }
  });

  it('produces url-safe base64 without padding', () => {
    const b64url = toB64Url(new Uint8Array([0xfb, 0xff, 0xfe]));
    expect(b64url).not.toMatch(/[+/=]/);
  });

  it('handles buffers larger than the fromCharCode argument limit', () => {
    const big = randomBytes(200_000);
    expect(fromB64(toB64(big))).toEqual(big);
  });

  it('round-trips utf-8 including non-ascii', () => {
    const s = 'andre@example.org - passwoerd';
    expect(fromUtf8(utf8(s))).toBe(s);
  });

  it('concatenates', () => {
    expect(concat(new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3]))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('xors and rejects length mismatch', () => {
    expect(xor(new Uint8Array([0xf0, 0x0f]), new Uint8Array([0xff, 0xff]))).toEqual(
      new Uint8Array([0x0f, 0xf0]),
    );
    expect(() => xor(new Uint8Array(2), new Uint8Array(3))).toThrow(/length mismatch/);
  });

  it('compares in constant time', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('mints 12-byte url-safe record ids like Firefox does', () => {
    const id = newRecordId();
    expect(id).toHaveLength(16);
    expect(id).not.toMatch(/[+/=]/);
    expect(fromB64Url(id)).toHaveLength(12);
    expect(new Set(Array.from({ length: 200 }, newRecordId)).size).toBe(200);
  });
});

describe('HMAC-SHA256 (RFC 4231)', () => {
  it('test case 1', async () => {
    const key = new Uint8Array(20).fill(0x0b);
    const mac = await hmacSha256(key, utf8('Hi There'));
    expect(toHex(mac)).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });

  it('test case 2', async () => {
    const mac = await hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?'));
    expect(toHex(mac)).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
});

describe('SHA-256', () => {
  it('hashes the empty string', async () => {
    expect(toHex(await sha256(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes "abc"', async () => {
    expect(toHex(await sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('HKDF-SHA256 (RFC 5869)', () => {
  it('test case 1 - with salt and info', async () => {
    const okm = await hkdf(
      new Uint8Array(22).fill(0x0b),
      fromHex('000102030405060708090a0b0c'),
      fromHex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(toHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('test case 3 - zero-length salt and info, the FxA case', async () => {
    const okm = await hkdf(
      new Uint8Array(22).fill(0x0b),
      new Uint8Array(0),
      new Uint8Array(0),
      42,
    );
    expect(toHex(okm)).toBe(
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    );
  });

  it('an empty salt is equivalent to 32 zero bytes', async () => {
    const ikm = randomBytes(32);
    const info = utf8('identity.mozilla.com/picl/v1/oldsync');
    const a = await hkdf(ikm, new Uint8Array(0), info, 64);
    const b = await hkdf(ikm, new Uint8Array(32), info, 64);
    expect(toHex(a)).toBe(toHex(b));
  });

  it('expands across multiple blocks consistently', async () => {
    const ikm = randomBytes(32);
    const info = utf8('ctx');
    const long = await hkdf(ikm, new Uint8Array(0), info, 96);
    const short = await hkdf(ikm, new Uint8Array(0), info, 32);
    expect(toHex(long.slice(0, 32))).toBe(toHex(short));
  });
});

describe('PBKDF2-HMAC-SHA256 (RFC 7914)', () => {
  it('c=1', async () => {
    const dk = await pbkdf2(utf8('passwd'), utf8('salt'), 1, 64);
    expect(toHex(dk)).toBe(
      '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc' +
        '49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783',
    );
  });

  it('c=80000', async () => {
    const dk = await pbkdf2(utf8('Password'), utf8('NaCl'), 80000, 64);
    expect(toHex(dk)).toBe(
      '4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56' +
        'a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d',
    );
  });
});

describe('AES', () => {
  it('round-trips AES-256-CBC', async () => {
    const key = randomBytes(32);
    const iv = randomBytes(16);
    const pt = utf8(JSON.stringify({ hello: 'world', n: 42 }));
    const ct = await aesCbcEncrypt(key, iv, pt);
    expect(ct.length % 16).toBe(0);
    expect(fromUtf8(await aesCbcDecrypt(key, iv, ct))).toBe(fromUtf8(pt));
  });

  it('round-trips AES-256-GCM with AAD', async () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const aad = utf8('firesync.vault.v1');
    const ct = await aesGcmEncrypt(key, iv, utf8('secret'), aad);
    expect(fromUtf8(await aesGcmDecrypt(key, iv, ct, aad))).toBe('secret');
  });

  it('rejects AES-256-GCM with the wrong AAD', async () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const ct = await aesGcmEncrypt(key, iv, utf8('secret'), utf8('a'));
    await expect(aesGcmDecrypt(key, iv, ct, utf8('b'))).rejects.toThrow();
  });

  it('rejects a tampered AES-256-GCM ciphertext', async () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const ct = await aesGcmEncrypt(key, iv, utf8('secret'));
    ct[0] = (ct[0] as number) ^ 0x01;
    await expect(aesGcmDecrypt(key, iv, ct)).rejects.toThrow();
  });
});
