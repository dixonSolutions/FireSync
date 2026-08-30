import { describe, expect, it } from 'vitest';
import { concat, fromB64, randomBytes, toHex, xor } from '../src/common/bytes.ts';
import { hkdf, hmacSha256 } from '../src/common/crypto.ts';
import { FxAClient } from '../src/fxa/client.ts';
import { ConnectSession } from '../src/fxa/connect.ts';
import { FxAError, FxANetworkError } from '../src/fxa/errors.ts';
import {
  deriveKeyFetchCredentials,
  deriveLoginCredentials,
  deriveSyncKeys,
  KW,
  OLDSYNC_SCOPE,
} from '../src/fxa/onepw.ts';

const AUTH = 'https://auth.test/v1';

interface Route {
  method: string;
  path: string;
  status?: number;
  body: unknown | ((request: { body: unknown; headers: Record<string, string> }) => unknown);
}

function scripted(routes: Route[]) {
  const seen: { method: string; path: string; body: unknown; headers: Record<string, string> }[] =
    [];

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace('/v1', '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method, path, body, headers });

    const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
    if (!route) {
      return new Response(JSON.stringify({ errno: 999, message: `no route for ${method} ${path}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const payload = typeof route.body === 'function' ? route.body({ body, headers }) : route.body;
    return new Response(JSON.stringify(payload), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetchImpl, seen };
}

/** Build a valid /account/keys bundle for a given keyFetchToken. */
async function keysBundleFor(
  keyFetchTokenHex: string,
  unwrapBKey: Uint8Array,
  kA: Uint8Array,
  kB: Uint8Array,
): Promise<string> {
  const creds = await deriveKeyFetchCredentials(
    Uint8Array.from(
      keyFetchTokenHex.match(/../g)!.map((byte) => Number.parseInt(byte, 16)),
    ),
  );
  const material = await hkdf(creds.requestKey, new Uint8Array(0), KW('account/keys'), 96);
  const ciphertext = xor(concat(kA, xor(kB, unwrapBKey)), material.slice(32, 96));
  const mac = await hmacSha256(material.slice(0, 32), ciphertext);
  return toHex(concat(ciphertext, mac));
}

describe('FxAClient.signIn', () => {
  it('sends authPW rather than the password', async () => {
    const { fetchImpl, seen } = scripted([
      {
        method: 'POST',
        path: '/account/login',
        body: { uid: 'u', sessionToken: 'aa', keyFetchToken: 'bb', verified: true },
      },
    ]);
    const client = new FxAClient({ authServerUrl: AUTH, fetchImpl });

    await client.signIn('ada@example.org', 'hunter2');

    const request = seen[0]!;
    const expected = await deriveLoginCredentials('ada@example.org', 'hunter2');
    expect((request.body as { authPW: string }).authPW).toBe(toHex(expected.authPW));
    expect(JSON.stringify(request.body)).not.toContain('hunter2');
  });

  it('asks for keys by default', async () => {
    const { fetchImpl, seen } = scripted([
      { method: 'POST', path: '/account/login', body: { uid: 'u', sessionToken: 'aa', verified: true } },
    ]);
    await new FxAClient({ authServerUrl: AUTH, fetchImpl }).signIn('a@b.c', 'p');
    expect(seen[0]?.headers).toBeDefined();
  });

  it('turns an error body into an FxAError with the errno intact', async () => {
    const { fetchImpl } = scripted([
      {
        method: 'POST',
        path: '/account/login',
        status: 400,
        body: { code: 400, errno: 103, error: 'Bad Request', message: 'Incorrect password' },
      },
    ]);
    const client = new FxAClient({ authServerUrl: AUTH, fetchImpl });

    await expect(client.signIn('a@b.c', 'wrong')).rejects.toSatisfy((error: unknown) => {
      const fxaError = error as FxAError;
      return (
        fxaError instanceof FxAError &&
        fxaError.errno === 103 &&
        fxaError.isBadPassword &&
        fxaError.message === 'Incorrect password'
      );
    });
  });

  it('classifies the errors the UI branches on', () => {
    expect(new FxAError(400, { errno: 138 }).needsSessionVerification).toBe(true);
    expect(new FxAError(400, { errno: 125 }).needsUnblockCode).toBe(true);
    expect(new FxAError(429, { errno: 114, retryAfter: 30 }).isRateLimited).toBe(true);
    expect(new FxAError(429, { errno: 114, retryAfter: 30 }).retryAfter).toBe(30);
    expect(new FxAError(401, { errno: 111 }).isClockSkew).toBe(true);
  });

  it('wraps a transport failure as FxANetworkError', async () => {
    const client = new FxAClient({
      authServerUrl: AUTH,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(client.signIn('a@b.c', 'p')).rejects.toBeInstanceOf(FxANetworkError);
  });
});

describe('FxAClient.accountKeys', () => {
  it('unbundles kA and kB from a valid response', async () => {
    const kA = randomBytes(32);
    const kB = randomBytes(32);
    const keyFetchToken = toHex(randomBytes(32));
    const { unwrapBKey } = await deriveLoginCredentials('ada@example.org', 'hunter2');
    const bundle = await keysBundleFor(keyFetchToken, unwrapBKey, kA, kB);

    const { fetchImpl, seen } = scripted([
      { method: 'GET', path: '/account/keys', body: { bundle } },
    ]);
    const client = new FxAClient({ authServerUrl: AUTH, fetchImpl });

    const keys = await client.accountKeys(keyFetchToken, unwrapBKey);
    expect(toHex(keys.kA)).toBe(toHex(kA));
    expect(toHex(keys.kB)).toBe(toHex(kB));
    expect(seen[0]?.headers['authorization']).toMatch(/^Hawk id="[0-9a-f]{64}"/);
  });
});

describe('FxAClient OAuth', () => {
  it('mints tokens from a session token', async () => {
    const { fetchImpl, seen } = scripted([
      {
        method: 'POST',
        path: '/oauth/token',
        body: {
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          token_type: 'bearer',
          scope: OLDSYNC_SCOPE,
        },
      },
    ]);
    const client = new FxAClient({ authServerUrl: AUTH, fetchImpl, oauthClientId: 'cid' });

    const result = await client.createOAuthTokenFromSession(toHex(randomBytes(32)));
    expect(result.refresh_token).toBe('rt');
    expect(seen[0]?.body).toMatchObject({
      grant_type: 'fxa-credentials',
      client_id: 'cid',
      scope: OLDSYNC_SCOPE,
      access_type: 'offline',
    });
    expect(seen[0]?.headers['authorization']).toMatch(/^Hawk /);
  });

  it('refreshes without any Hawk credentials', async () => {
    const { fetchImpl, seen } = scripted([
      {
        method: 'POST',
        path: '/oauth/token',
        body: { access_token: 'at2', expires_in: 3600, token_type: 'bearer', scope: OLDSYNC_SCOPE },
      },
    ]);
    const client = new FxAClient({ authServerUrl: AUTH, fetchImpl });

    await client.refreshAccessToken('rt');
    expect(seen[0]?.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt' });
    expect(seen[0]?.headers['authorization']).toBeUndefined();
  });
});

describe('ConnectSession', () => {
  const kA = randomBytes(32);
  const kB = randomBytes(32);

  async function routes(loginResponse: Record<string, unknown>): Promise<Route[]> {
    const keyFetchToken = (loginResponse['keyFetchToken'] as string) ?? toHex(randomBytes(32));
    const { unwrapBKey } = await deriveLoginCredentials('ada@example.org', 'hunter2');
    return [
      { method: 'POST', path: '/account/login', body: loginResponse },
      { method: 'POST', path: '/session/verify/totp', body: { success: true } },
      { method: 'POST', path: '/session/verify_code', body: {} },
      {
        method: 'GET',
        path: '/account/keys',
        body: { bundle: await keysBundleFor(keyFetchToken, unwrapBKey, kA, kB) },
      },
      {
        method: 'POST',
        path: '/account/scoped-key-data',
        body: {
          [OLDSYNC_SCOPE]: {
            identifier: OLDSYNC_SCOPE,
            keyRotationSecret: '0'.repeat(64),
            keyRotationTimestamp: 1510628805,
          },
        },
      },
      {
        method: 'POST',
        path: '/oauth/token',
        body: {
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          token_type: 'bearer',
          scope: OLDSYNC_SCOPE,
        },
      },
      { method: 'POST', path: '/account/device', body: { id: 'device-1', name: 'FireSync', type: 'desktop' } },
      { method: 'POST', path: '/session/destroy', body: {} },
    ];
  }

  it('completes in one step for a verified session', async () => {
    const keyFetchToken = toHex(randomBytes(32));
    const { fetchImpl, seen } = scripted(
      await routes({ uid: 'uid-1', sessionToken: toHex(randomBytes(32)), keyFetchToken, verified: true }),
    );
    const session = new ConnectSession({
      client: new FxAClient({ authServerUrl: AUTH, fetchImpl, oauthClientId: 'cid' }),
      now: () => 1234,
    });

    const step = await session.begin('ada@example.org', 'hunter2');
    expect(step.kind).toBe('complete');
    if (step.kind !== 'complete') throw new Error('unreachable');

    const expectedKeys = await deriveSyncKeys(kB);
    expect(step.account).toMatchObject({
      uid: 'uid-1',
      email: 'ada@example.org',
      refreshToken: 'rt',
      deviceId: 'device-1',
      connectedAt: 1234,
    });
    expect(toHex(fromB64(step.account.kSync))).toBe(toHex(expectedKeys.kSync));
    expect(step.account.kid).toMatch(/^1510628805-[A-Za-z0-9_-]{22}$/);

    // The session token must be destroyed once OAuth tokens are in hand.
    expect(seen.map((request) => request.path)).toContain('/session/destroy');
  });

  it('stops for a TOTP code and completes after it is supplied', async () => {
    const keyFetchToken = toHex(randomBytes(32));
    const { fetchImpl } = scripted(
      await routes({
        uid: 'uid-1',
        sessionToken: toHex(randomBytes(32)),
        keyFetchToken,
        verified: false,
        verificationMethod: 'totp-2fa',
      }),
    );
    const session = new ConnectSession({
      client: new FxAClient({ authServerUrl: AUTH, fetchImpl, oauthClientId: 'cid' }),
    });

    expect((await session.begin('ada@example.org', 'hunter2')).kind).toBe('needs-totp');
    expect((await session.submitTotp('123456')).kind).toBe('complete');
  });

  it('stops for an emailed code when there is no TOTP', async () => {
    const keyFetchToken = toHex(randomBytes(32));
    const { fetchImpl } = scripted(
      await routes({
        uid: 'uid-1',
        sessionToken: toHex(randomBytes(32)),
        keyFetchToken,
        verified: false,
        verificationMethod: 'email-otp',
      }),
    );
    const session = new ConnectSession({
      client: new FxAClient({ authServerUrl: AUTH, fetchImpl, oauthClientId: 'cid' }),
    });

    const step = await session.begin('ada@example.org', 'hunter2');
    expect(step).toEqual({ kind: 'needs-email-code', email: 'ada@example.org' });
    expect((await session.submitEmailCode('000000')).kind).toBe('complete');
  });

  it('asks for an unblock code when Mozilla blocks the sign-in', async () => {
    const { fetchImpl, seen } = scripted([
      { method: 'POST', path: '/account/login', status: 400, body: { errno: 125, message: 'blocked' } },
      { method: 'POST', path: '/account/login/send_unblock_code', body: {} },
    ]);
    const session = new ConnectSession({
      client: new FxAClient({ authServerUrl: AUTH, fetchImpl }),
    });

    expect(await session.begin('ada@example.org', 'hunter2')).toEqual({
      kind: 'needs-unblock-code',
      email: 'ada@example.org',
    });
    expect(seen.map((request) => request.path)).toContain('/account/login/send_unblock_code');
  });

  it('refuses to continue without a keyFetchToken', async () => {
    const { fetchImpl } = scripted([
      { method: 'POST', path: '/account/login', body: { uid: 'u', sessionToken: 'aa', verified: true } },
    ]);
    const session = new ConnectSession({
      client: new FxAClient({ authServerUrl: AUTH, fetchImpl }),
    });
    await expect(session.begin('a@b.c', 'p')).rejects.toThrow(/keyFetchToken/);
  });

  it('rejects a TOTP submission with no sign-in in progress', async () => {
    const session = new ConnectSession();
    await expect(session.submitTotp('123456')).rejects.toThrow(/no active sign-in/);
  });
});
