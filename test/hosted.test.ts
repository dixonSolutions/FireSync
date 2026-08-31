import { describe, expect, it } from 'vitest';
import { fromB64, fromB64Url, randomBytes, toB64, toB64Url, utf8 } from '../src/common/bytes.ts';
import {
  ecdhDeriveBits,
  exportJwk,
  generateEcdhKeyPair,
  importEcdhPublicJwk,
  sha256,
} from '../src/common/crypto.ts';
import { FxAClient, DEFAULT_HOSTED_CLIENT_ID, hostedRedirectUri } from '../src/fxa/client.ts';
import { HostedSignIn } from '../src/fxa/hosted.ts';
import { OLDSYNC_SCOPE } from '../src/fxa/onepw.ts';

const AUTH = 'https://auth.test/v1';
const PROFILE = 'https://profile.test/v1';
const CONTENT = 'https://accounts.test';

/** Encrypt a scoped-key bundle to the client's ephemeral public key. */
async function makeKeysJwe(keysJwk: string, kSync: Uint8Array, kid: string): Promise<string> {
  const publicJwk = JSON.parse(new TextDecoder().decode(fromB64Url(keysJwk)));
  const recipient = await importEcdhPublicJwk(publicJwk);
  const ephemeral = await generateEcdhKeyPair();
  const epkFull = (await exportJwk(ephemeral.publicKey)) as JsonWebKey;
  const epk = { kty: epkFull.kty, crv: epkFull.crv, x: epkFull.x, y: epkFull.y };

  const z = await ecdhDeriveBits(ephemeral.privateKey, recipient, 32);
  const be32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false);
    return b;
  };
  const withLen = (b: Uint8Array) => new Uint8Array([...be32(b.length), ...b]);
  const cek = (
    await sha256(
      new Uint8Array([
        ...be32(1),
        ...z,
        ...withLen(utf8('A256GCM')),
        ...withLen(new Uint8Array(0)),
        ...withLen(new Uint8Array(0)),
        ...be32(256),
      ]),
    )
  ).slice(0, 32);

  const header = toB64Url(utf8(JSON.stringify({ alg: 'ECDH-ES', enc: 'A256GCM', epk })));
  const iv = randomBytes(12);
  const key = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt']);
  const payload = JSON.stringify({
    [OLDSYNC_SCOPE]: { kty: 'oct', kid, k: toB64Url(kSync) },
  });
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128, additionalData: utf8(header) as BufferSource },
      key,
      utf8(payload) as BufferSource,
    ),
  );
  return [
    header,
    '',
    toB64Url(iv),
    toB64Url(sealed.slice(0, sealed.length - 16)),
    toB64Url(sealed.slice(sealed.length - 16)),
  ].join('.');
}

function harness(overrides: { tokenBody?: (keysJwe: string) => unknown } = {}) {
  const seen: { path: string; body: unknown; headers: Record<string, string> }[] = [];
  let keysJwe = '';

  const client = new FxAClient({
    authServerUrl: AUTH,
    profileServerUrl: PROFILE,
    contentServerUrl: CONTENT,
    oauthClientId: DEFAULT_HOSTED_CLIENT_ID,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ path: url.pathname, body, headers: (init?.headers ?? {}) as Record<string, string> });

      if (url.pathname.endsWith('/oauth/token')) {
        const payload = overrides.tokenBody
          ? overrides.tokenBody(keysJwe)
          : {
              access_token: 'access-token',
              refresh_token: 'refresh-token',
              expires_in: 3600,
              token_type: 'bearer',
              scope: OLDSYNC_SCOPE,
              keys_jwe: keysJwe,
            };
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      if (url.pathname.endsWith('/profile')) {
        return new Response(JSON.stringify({ uid: 'uid-9', email: 'ada@example.org' }), {
          status: 200,
        });
      }
      return new Response('{}', { status: 404 });
    },
  });

  return { client, seen, setKeysJwe: (value: string) => (keysJwe = value) };
}

describe('hosted redirect URI', () => {
  it('is the OAuth client\'s registered success URL', () => {
    expect(hostedRedirectUri('abc123', 'https://accounts.firefox.com')).toBe(
      'https://accounts.firefox.com/oauth/success/abc123',
    );
  });
});

describe('HostedSignIn.start', () => {
  it('builds an authorization URL with a scoped-key request and PKCE', async () => {
    const { client } = harness();
    const flow = new HostedSignIn({ client, contentServerUrl: CONTENT, now: () => 42 });
    const pending = await flow.start({ email: 'ada@example.org' });

    const url = new URL(pending.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${CONTENT}/authorization`);
    expect(url.searchParams.get('client_id')).toBe(DEFAULT_HOSTED_CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toContain(OLDSYNC_SCOPE);
    expect(url.searchParams.get('email')).toBe('ada@example.org');
    expect(url.searchParams.get('redirect_uri')).toBe(pending.redirectUri);

    // The scoped-key request must be a bare public JWK.
    const jwk = JSON.parse(
      new TextDecoder().decode(fromB64Url(url.searchParams.get('keys_jwk') as string)),
    );
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(pending.startedAt).toBe(42);
  });

  it('mints a fresh state and key pair every time', async () => {
    const { client } = harness();
    const flow = new HostedSignIn({ client, contentServerUrl: CONTENT });
    const a = await flow.start();
    const b = await flow.start();
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(JSON.stringify(a.privateKeyJwk)).not.toBe(JSON.stringify(b.privateKeyJwk));
  });
});

describe('HostedSignIn.matches', () => {
  it('recognises the redirect and ignores everything else', async () => {
    const { client } = harness();
    const flow = new HostedSignIn({ client, contentServerUrl: CONTENT });
    const pending = await flow.start();

    expect(flow.matches(`${pending.redirectUri}?code=abc&state=${pending.state}`, pending)).toBe(true);
    expect(flow.matches(`${CONTENT}/signin`, pending)).toBe(false);
    expect(flow.matches('https://evil.test/oauth/success/x?code=abc', pending)).toBe(false);
    expect(flow.matches('not a url', pending)).toBe(false);
  });

  it('throws on a state mismatch rather than proceeding', async () => {
    const { client } = harness();
    const flow = new HostedSignIn({ client, contentServerUrl: CONTENT });
    const pending = await flow.start();
    expect(() => flow.matches(`${pending.redirectUri}?code=abc&state=wrong`, pending)).toThrow(
      /state mismatch/,
    );
  });

  it('throws when Mozilla redirects with an error', async () => {
    const { client } = harness();
    const flow = new HostedSignIn({ client, contentServerUrl: CONTENT });
    const pending = await flow.start();
    expect(() => flow.matches(`${pending.redirectUri}?error=access_denied`, pending)).toThrow(
      /authorization failed/,
    );
  });
});

describe('HostedSignIn.complete', () => {
  it('exchanges the code and unwraps the sync key, without ever seeing a password', async () => {
    const kSync = randomBytes(64);
    const h = harness();
    const flow = new HostedSignIn({ client: h.client, contentServerUrl: CONTENT, now: () => 777 });
    const pending = await flow.start();
    h.setKeysJwe(await makeKeysJwe(
      new URL(pending.authorizationUrl).searchParams.get('keys_jwk') as string,
      kSync,
      '1510628805-abcdefghijklmnopqrstuv',
    ));

    const account = await flow.complete(
      `${pending.redirectUri}?code=the-code&state=${pending.state}`,
      pending,
    );

    expect(account).toMatchObject({
      uid: 'uid-9',
      email: 'ada@example.org',
      refreshToken: 'refresh-token',
      kid: '1510628805-abcdefghijklmnopqrstuv',
      connectedAt: 777,
    });
    expect(fromB64(account.kSync)).toEqual(kSync);

    // The code exchange must use PKCE and carry no credentials of any kind.
    const exchange = h.seen.find((r) => r.path.endsWith('/oauth/token'));
    expect(exchange?.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: pending.codeVerifier,
    });
    expect(JSON.stringify(h.seen)).not.toContain('authPW');
    expect(JSON.stringify(h.seen)).not.toContain('sessionToken');
    // No Hawk anywhere: this flow never holds a session token.
    expect(JSON.stringify(h.seen)).not.toContain('Hawk');
  });

  it('refuses a redirect it was not waiting for', async () => {
    const h = harness();
    const flow = new HostedSignIn({ client: h.client, contentServerUrl: CONTENT });
    const pending = await flow.start();
    await expect(flow.complete(`${CONTENT}/elsewhere`, pending)).rejects.toThrow(
      /not the authorization redirect/,
    );
  });

  it('fails clearly when Mozilla returns no scoped key', async () => {
    const h = harness({
      tokenBody: () => ({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3600,
        token_type: 'bearer',
        scope: OLDSYNC_SCOPE,
      }),
    });
    const flow = new HostedSignIn({ client: h.client, contentServerUrl: CONTENT });
    const pending = await flow.start();
    await expect(
      flow.complete(`${pending.redirectUri}?code=c&state=${pending.state}`, pending),
    ).rejects.toThrow(/granted the oldsync scope but returned no sync key/);
  });

  /**
   * The two ways a sign-in can end up without a sync key need opposite fixes —
   * set a Mozilla password, versus use a different OAuth client — so the error
   * has to say which one happened rather than guess.
   */
  /**
   * A refresh token belongs to the client it was issued to. The hosted flow and
   * the password flow use different clients, so the sync engine cannot guess —
   * the client has to be stored alongside the token it goes with.
   */
  it('records the OAuth client the refresh token was issued to', async () => {
    const kSync = randomBytes(64);
    const h = harness();
    const flow = new HostedSignIn({ client: h.client, contentServerUrl: CONTENT });
    const pending = await flow.start();
    h.setKeysJwe(await makeKeysJwe(
      new URL(pending.authorizationUrl).searchParams.get('keys_jwk') as string,
      kSync,
      '1510628805-abcdefghijklmnopqrstuv',
    ));

    const account = await flow.complete(
      `${pending.redirectUri}?code=c&state=${pending.state}`,
      pending,
    );
    expect(account.clientId).toBe(DEFAULT_HOSTED_CLIENT_ID);
  });

  it('names the account, not the client, when oldsync was granted but no key came back', async () => {
    const h = harness({
      tokenBody: () => ({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3600,
        token_type: 'bearer',
        scope: `profile ${OLDSYNC_SCOPE}`,
      }),
    });
    const flow = new HostedSignIn({ client: h.client, contentServerUrl: CONTENT });
    const pending = await flow.start();
    const error = await flow
      .complete(`${pending.redirectUri}?code=c&state=${pending.state}`, pending)
      .catch((e: Error) => e);
    expect((error as Error).message).toMatch(/no key material/);
    expect((error as Error).message).toMatch(/Google or Apple/);
    expect((error as Error).message).toContain(OLDSYNC_SCOPE);
  });

  it('names the client when oldsync was never granted at all', async () => {
    const h = harness({
      tokenBody: () => ({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3600,
        token_type: 'bearer',
        scope: 'profile',
      }),
    });
    const flow = new HostedSignIn({ client: h.client, contentServerUrl: CONTENT });
    const pending = await flow.start();
    const error = await flow
      .complete(`${pending.redirectUri}?code=c&state=${pending.state}`, pending)
      .catch((e: Error) => e);
    expect((error as Error).message).toMatch(/did not grant the oldsync scope/);
    expect((error as Error).message).toMatch(/not permitted scoped keys/);
    expect((error as Error).message).toContain('Granted scope: profile');
  });

  it('fails clearly when there is no refresh token to persist', async () => {
    const h = harness({
      tokenBody: (jwe) => ({
        access_token: 'a',
        expires_in: 3600,
        token_type: 'bearer',
        scope: OLDSYNC_SCOPE,
        keys_jwe: jwe,
      }),
    });
    const flow = new HostedSignIn({ client: h.client, contentServerUrl: CONTENT });
    const pending = await flow.start();
    await expect(
      flow.complete(`${pending.redirectUri}?code=c&state=${pending.state}`, pending),
    ).rejects.toThrow(/did not issue a refresh token/);
  });

  it('survives a profile lookup failure rather than losing the sign-in', async () => {
    const kSync = randomBytes(64);
    const seen: string[] = [];
    const client = new FxAClient({
      authServerUrl: AUTH,
      profileServerUrl: PROFILE,
      contentServerUrl: CONTENT,
      oauthClientId: DEFAULT_HOSTED_CLIENT_ID,
      fetchImpl: async (input) => {
        seen.push(input);
        if (input.includes('/profile')) return new Response('nope', { status: 500 });
        return new Response(
          JSON.stringify({
            access_token: 'a',
            refresh_token: 'r',
            expires_in: 3600,
            token_type: 'bearer',
            scope: OLDSYNC_SCOPE,
            keys_jwe: jwe,
          }),
          { status: 200 },
        );
      },
    });
    const flow = new HostedSignIn({ client, contentServerUrl: CONTENT });
    const pending = await flow.start();
    const jwe = await makeKeysJwe(
      new URL(pending.authorizationUrl).searchParams.get('keys_jwk') as string,
      kSync,
      '1-abc',
    );

    const account = await flow.complete(
      `${pending.redirectUri}?code=c&state=${pending.state}`,
      pending,
    );
    expect(account.refreshToken).toBe('r');
    expect(fromB64(account.kSync)).toEqual(kSync);
    expect(account.email).toBe('');
  });
});
