import { describe, expect, it } from 'vitest';
import { concat, fromB64Url, randomBytes, toB64Url, utf8 } from '../src/common/bytes.ts';
import {
  ecdhDeriveBits,
  exportJwk,
  generateEcdhKeyPair,
  importEcdhPublicJwk,
  sha256,
} from '../src/common/crypto.ts';
import { concatKdf, decryptEcdhEsJwe, parseCompactJwe } from '../src/fxa/jwe.ts';
import {
  buildAuthorizationUrl,
  createPkcePair,
  createScopedKeyRequest,
  newState,
  parseRedirect,
  unwrapScopedKeys,
} from '../src/fxa/oauth.ts';
import { OLDSYNC_SCOPE } from '../src/fxa/onepw.ts';

/**
 * An independent Concat KDF, written from the NIST description rather than by
 * calling the production one, so the test is a real cross-check.
 */
async function referenceConcatKdf(
  z: Uint8Array,
  keyBits: number,
  algorithmId: string,
): Promise<Uint8Array> {
  const be32 = (value: number): Uint8Array => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, false);
    return out;
  };
  const withLength = (data: Uint8Array): Uint8Array => concat(be32(data.length), data);
  const input = concat(
    be32(1),
    z,
    withLength(utf8(algorithmId)),
    withLength(new Uint8Array(0)),
    withLength(new Uint8Array(0)),
    be32(keyBits),
  );
  return (await sha256(input)).slice(0, keyBits / 8);
}

/** Produce an `ECDH-ES` + `A256GCM` compact JWE for a recipient public key. */
async function makeJwe(recipientPublic: CryptoKey, plaintext: string): Promise<string> {
  const ephemeral = await generateEcdhKeyPair();
  const epkFull = (await exportJwk(ephemeral.publicKey)) as JsonWebKey;
  const epk = { kty: epkFull.kty, crv: epkFull.crv, x: epkFull.x, y: epkFull.y };

  const z = await ecdhDeriveBits(ephemeral.privateKey, recipientPublic, 32);
  const cek = await referenceConcatKdf(z, 256, 'A256GCM');

  const header = toB64Url(utf8(JSON.stringify({ alg: 'ECDH-ES', enc: 'A256GCM', epk })));
  const iv = randomBytes(12);

  const key = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, [
    'encrypt',
  ]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128, additionalData: utf8(header) as BufferSource },
      key,
      utf8(plaintext) as BufferSource,
    ),
  );
  const ciphertext = sealed.slice(0, sealed.length - 16);
  const tag = sealed.slice(sealed.length - 16);

  return [header, '', toB64Url(iv), toB64Url(ciphertext), toB64Url(tag)].join('.');
}

describe('concatKdf', () => {
  it('agrees with an independently written implementation', async () => {
    const z = randomBytes(32);
    expect(await concatKdf(z, 256, 'A256GCM', new Uint8Array(0), new Uint8Array(0))).toEqual(
      await referenceConcatKdf(z, 256, 'A256GCM'),
    );
  });

  it('produces different keys for different algorithm ids', async () => {
    const z = randomBytes(32);
    const a = await concatKdf(z, 256, 'A256GCM', new Uint8Array(0), new Uint8Array(0));
    const b = await concatKdf(z, 256, 'A128GCM', new Uint8Array(0), new Uint8Array(0));
    expect(a).not.toEqual(b);
  });

  it('refuses multi-round derivation it does not implement', async () => {
    await expect(
      concatKdf(randomBytes(32), 512, 'A256GCM', new Uint8Array(0), new Uint8Array(0)),
    ).rejects.toThrow(/single-round/);
  });
});

describe('parseCompactJwe', () => {
  it('rejects anything that is not five segments', () => {
    expect(() => parseCompactJwe('a.b.c')).toThrow(/expected 5 segments/);
  });
});

describe('decryptEcdhEsJwe', () => {
  it('round-trips a JWE built by an independent encryptor', async () => {
    const recipient = await generateEcdhKeyPair();
    const jwe = await makeJwe(recipient.publicKey, '{"hello":"scoped keys"}');
    expect(await decryptEcdhEsJwe(jwe, recipient.privateKey)).toBe('{"hello":"scoped keys"}');
  });

  it('fails with the wrong private key', async () => {
    const recipient = await generateEcdhKeyPair();
    const stranger = await generateEcdhKeyPair();
    const jwe = await makeJwe(recipient.publicKey, 'secret');
    await expect(decryptEcdhEsJwe(jwe, stranger.privateKey)).rejects.toThrow();
  });

  it('fails when the protected header is tampered with', async () => {
    const recipient = await generateEcdhKeyPair();
    const jwe = await makeJwe(recipient.publicKey, 'secret');
    const parts = jwe.split('.');
    const header = JSON.parse(new TextDecoder().decode(fromB64Url(parts[0] as string)));
    parts[0] = toB64Url(utf8(JSON.stringify({ ...header, extra: 'tampered' })));
    await expect(decryptEcdhEsJwe(parts.join('.'), recipient.privateKey)).rejects.toThrow();
  });

  it('refuses algorithms it does not implement', async () => {
    const recipient = await generateEcdhKeyPair();
    const header = toB64Url(utf8(JSON.stringify({ alg: 'RSA-OAEP', enc: 'A256GCM' })));
    await expect(
      decryptEcdhEsJwe(`${header}...${toB64Url(utf8('x'))}.`, recipient.privateKey),
    ).rejects.toThrow(/unsupported JWE alg/);
  });

  it('refuses a non-empty encrypted key segment', async () => {
    const recipient = await generateEcdhKeyPair();
    const header = toB64Url(
      utf8(JSON.stringify({ alg: 'ECDH-ES', enc: 'A256GCM', epk: {} })),
    );
    const compact = [
      header,
      toB64Url(utf8('key')),
      toB64Url(randomBytes(12)),
      toB64Url(randomBytes(16)),
      toB64Url(randomBytes(16)),
    ].join('.');
    await expect(decryptEcdhEsJwe(compact, recipient.privateKey)).rejects.toThrow(
      /direct key agreement/,
    );
  });

  it('reports a segment that is not valid base64url', async () => {
    const recipient = await generateEcdhKeyPair();
    await expect(decryptEcdhEsJwe('!!!...x.y', recipient.privateKey)).rejects.toThrow(
      /not valid base64url|unreadable protected header/,
    );
  });
});

describe('scoped key OAuth flow', () => {
  it('creates a PKCE pair whose challenge is S256 of the verifier', async () => {
    const pair = await createPkcePair();
    expect(pair.codeVerifier).not.toMatch(/[+/=]/);
    expect(pair.codeChallenge).toBe(toB64Url(await sha256(utf8(pair.codeVerifier))));
  });

  it('encodes keys_jwk as base64url of a bare public JWK', async () => {
    const request = await createScopedKeyRequest();
    const jwk = JSON.parse(new TextDecoder().decode(fromB64Url(request.keysJwk)));
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(jwk.kty).toBe('EC');
    expect(jwk.crv).toBe('P-256');
    await expect(importEcdhPublicJwk(jwk)).resolves.toBeDefined();
  });

  it('builds an authorization URL with every required parameter', async () => {
    const pkce = await createPkcePair();
    const request = await createScopedKeyRequest();
    const url = new URL(
      buildAuthorizationUrl({
        contentServerUrl: 'https://accounts.firefox.com',
        clientId: 'abc123',
        redirectUri: 'https://example.invalid/redirect',
        state: 'state-value',
        codeChallenge: pkce.codeChallenge,
        keysJwk: request.keysJwk,
      }),
    );

    expect(url.origin).toBe('https://accounts.firefox.com');
    expect(url.pathname).toBe('/authorization');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain(OLDSYNC_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('keys_jwk')).toBe(request.keysJwk);
  });

  it('parses a matching redirect and enforces the state value', () => {
    const expected = { redirectUri: 'https://example.invalid/redirect', state: 'st' };

    expect(parseRedirect('https://example.invalid/redirect?code=c&state=st', expected)).toEqual({
      code: 'c',
      state: 'st',
    });
    expect(parseRedirect('https://elsewhere.invalid/redirect?code=c&state=st', expected)).toBeNull();
    expect(parseRedirect('not a url', expected)).toBeNull();
    expect(parseRedirect('https://example.invalid/redirect', expected)).toBeNull();
    expect(() =>
      parseRedirect('https://example.invalid/redirect?code=c&state=wrong', expected),
    ).toThrow(/state mismatch/);
    expect(() =>
      parseRedirect('https://example.invalid/redirect?error=access_denied', expected),
    ).toThrow(/authorization failed/);
  });

  it('generates unpredictable state values', () => {
    expect(new Set(Array.from({ length: 50 }, newState)).size).toBe(50);
  });

  it('unwraps the oldsync key from a scoped key bundle', async () => {
    const request = await createScopedKeyRequest();
    const kSync = randomBytes(64);
    const bundle = {
      [OLDSYNC_SCOPE]: { kty: 'oct', kid: '1510628805-abc', k: toB64Url(kSync) },
    };
    const jwe = await makeJwe(
      await importEcdhPublicJwk(
        JSON.parse(new TextDecoder().decode(fromB64Url(request.keysJwk))),
      ),
      JSON.stringify(bundle),
    );

    const result = await unwrapScopedKeys(jwe, request.privateKey);
    expect(result.kid).toBe('1510628805-abc');
    expect(result.keys.kSync).toEqual(kSync);
    expect(result.keys.encKey).toEqual(kSync.slice(0, 32));
  });

  it('reports a missing scope clearly', async () => {
    const request = await createScopedKeyRequest();
    const jwe = await makeJwe(
      await importEcdhPublicJwk(
        JSON.parse(new TextDecoder().decode(fromB64Url(request.keysJwk))),
      ),
      JSON.stringify({ 'https://identity.mozilla.com/apps/notes': { k: 'x' } }),
    );
    await expect(unwrapScopedKeys(jwe, request.privateKey)).rejects.toThrow(/no entry for/);
  });

  it('rejects an oldsync key of the wrong length', async () => {
    const request = await createScopedKeyRequest();
    const jwe = await makeJwe(
      await importEcdhPublicJwk(
        JSON.parse(new TextDecoder().decode(fromB64Url(request.keysJwk))),
      ),
      JSON.stringify({ [OLDSYNC_SCOPE]: { kid: 'k', k: toB64Url(randomBytes(32)) } }),
    );
    await expect(unwrapScopedKeys(jwe, request.privateKey)).rejects.toThrow(/must be 64 bytes/);
  });
});
