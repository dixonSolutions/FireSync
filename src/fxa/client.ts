/**
 * Firefox Accounts auth-server client.
 *
 * Covers exactly the surface FireSync needs: sign in with keys, walk the
 * verification gauntlet (email code / TOTP / sign-in unblock), fetch and
 * unbundle the account keys, mint OAuth tokens, and then throw the session
 * token away.
 *
 * `fetch` is injectable so the whole thing is testable without a network.
 */

import { fromHex, toHex } from '../common/bytes.ts';
import { hawkHeader } from '../common/hawk.ts';
import type { HawkCredentials } from '../common/hawk.ts';
import { FxAError, FxANetworkError } from './errors.ts';
import {
  deriveKeyFetchCredentials,
  deriveLoginCredentials,
  deriveSessionCredentials,
  OLDSYNC_SCOPE,
  unbundleAccountKeysHex,
} from './onepw.ts';
import type {
  AccountKeys,
} from './onepw.ts';
import type {
  AccountKeysResponse,
  DeviceResponse,
  FxAErrorBody,
  OAuthTokenResponse,
  RecoveryEmailStatus,
  ScopedKeyDataResponse,
  SignInResponse,
} from './types.ts';

export const DEFAULT_AUTH_SERVER = 'https://api.accounts.firefox.com/v1';
export const DEFAULT_CONTENT_SERVER = 'https://accounts.firefox.com';
export const DEFAULT_PROFILE_SERVER = 'https://profile.accounts.firefox.com/v1';

/**
 * Firefox Accounts has no self-serve OAuth client registration. Third-party
 * Sync clients reuse a Mozilla *public* client id (public by construction —
 * it ships inside every Firefox binary). This is unsanctioned and Mozilla may
 * gate it at any time, which is exactly why it is configuration and not a
 * hardcoded constant: see docs/PROTOCOL.md#oauth-client-identity.
 */
export const DEFAULT_OAUTH_CLIENT_ID = '5882386c6d801776';

/**
 * The client used for the hosted sign-in flow, where the user authenticates on
 * Mozilla's own page and FireSync never sees the password.
 *
 * It has to be a *different* client from the one above: Firefox Desktop's
 * registered redirect is a WebChannel
 * (`urn:ietf:wg:oauth:2.0:oob:oauth-redirect-webchannel`), which an extension
 * cannot intercept. This client has a plain https redirect that a tab
 * navigates to, which `chrome.tabs.onUpdated` can see.
 *
 * Verified against the live service: FxA accepts this client with the oldsync
 * scope, PKCE, and a `keys_jwk` scoped-key request, and grants the scope — a
 * real sign-in came back with `scope: profile https://identity.mozilla.com/apps/oldsync`.
 *
 * Granting the scope is not the same as returning a key. `keys_jwe` is produced
 * by the content server from key material the *session* holds, so a session
 * established through Google or Apple grants oldsync and returns no key. That
 * is an account-and-session limit, not a limit of this client, and the password
 * flow is the way through it.
 */
export const DEFAULT_HOSTED_CLIENT_ID = '3c49430b43dfba77';

/** Where that client's authorization redirects land. */
export function hostedRedirectUri(clientId: string, contentServerUrl = DEFAULT_CONTENT_SERVER): string {
  return `${contentServerUrl.replace(/\/+$/, '')}/oauth/success/${clientId}`;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FxAClientOptions {
  authServerUrl?: string;
  contentServerUrl?: string;
  profileServerUrl?: string;
  oauthClientId?: string;
  fetchImpl?: FetchLike;
  userAgent?: string;
}

export interface SignInOptions {
  /** Ask for a keyFetchToken. Required for anything Sync-related. */
  keys?: boolean;
  reason?: 'login' | 'signup';
  /** Preferred second factor when the account has more than one. */
  verificationMethod?: 'email-otp' | 'totp-2fa';
  /** Code from the "suspicious sign-in" email. */
  unblockCode?: string;
}

export class FxAClient {
  readonly authServerUrl: string;
  readonly contentServerUrl: string;
  readonly profileServerUrl: string;
  readonly oauthClientId: string;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string | undefined;
  /** Learned from `Timestamp`/`Date` response headers; corrects Hawk skew. */
  private clockOffsetSec = 0;

  constructor(options: FxAClientOptions = {}) {
    this.authServerUrl = (options.authServerUrl ?? DEFAULT_AUTH_SERVER).replace(/\/+$/, '');
    this.contentServerUrl = (options.contentServerUrl ?? DEFAULT_CONTENT_SERVER).replace(
      /\/+$/,
      '',
    );
    this.profileServerUrl = (options.profileServerUrl ?? DEFAULT_PROFILE_SERVER).replace(
      /\/+$/,
      '',
    );
    this.oauthClientId = options.oauthClientId ?? DEFAULT_OAUTH_CLIENT_ID;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.userAgent = options.userAgent;
  }

  get clockOffsetSeconds(): number {
    return this.clockOffsetSec;
  }

  // ---------------------------------------------------------------- transport

  private url(path: string): string {
    return `${this.authServerUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private learnClockOffset(response: Response): void {
    const serverDate = response.headers.get('date');
    if (!serverDate) return;
    const serverSec = Math.floor(Date.parse(serverDate) / 1000);
    if (Number.isNaN(serverSec)) return;
    this.clockOffsetSec = serverSec - Math.floor(Date.now() / 1000);
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; hawk?: HawkCredentials; bearer?: string } = {},
  ): Promise<T> {
    const url = this.url(path);
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (this.userAgent) headers['user-agent'] = this.userAgent;

    if (options.hawk) {
      const { header } = await hawkHeader({
        method,
        url,
        credentials: options.hawk,
        ...(payload !== undefined ? { payload, contentType: 'application/json' } : {}),
        localtimeOffsetSec: this.clockOffsetSec,
      });
      headers['authorization'] = header;
    } else if (options.bearer) {
      headers['authorization'] = `Bearer ${options.bearer}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
      });
    } catch (cause) {
      throw new FxANetworkError(`could not reach ${url}`, cause);
    }

    this.learnClockOffset(response);

    const text = await response.text();
    const parsed: unknown = text ? safeJsonParse(text) : {};

    if (!response.ok) {
      const body = (parsed ?? {}) as FxAErrorBody;
      // The auth server sends its own clock in this header when it rejects a
      // Hawk timestamp; adopting it makes the immediate retry succeed.
      const serverTime = response.headers.get('timestamp');
      if (serverTime) {
        const serverSec = Number(serverTime);
        if (!Number.isNaN(serverSec)) {
          this.clockOffsetSec = serverSec - Math.floor(Date.now() / 1000);
        }
      }
      throw new FxAError(response.status, body);
    }

    return parsed as T;
  }

  // ------------------------------------------------------------------- sign in

  /**
   * `POST /account/login`. Returns the raw response plus the derived
   * `unwrapBKey`, which the caller needs later to unwrap kB and which never
   * leaves the device.
   */
  async signIn(
    email: string,
    password: string,
    options: SignInOptions = {},
  ): Promise<{ response: SignInResponse; unwrapBKey: Uint8Array }> {
    const { authPW, unwrapBKey } = await deriveLoginCredentials(email, password);
    const keys = options.keys !== false;
    const body: Record<string, unknown> = {
      email,
      authPW: toHex(authPW),
      reason: options.reason ?? 'login',
    };
    if (options.verificationMethod) body['verificationMethod'] = options.verificationMethod;
    if (options.unblockCode) body['unblockCode'] = options.unblockCode;

    const response = await this.request<SignInResponse>(
      'POST',
      `/account/login?keys=${keys ? 'true' : 'false'}`,
      { body },
    );
    return { response, unwrapBKey };
  }

  /** Ask Mozilla to email a sign-in unblock code (errno 125 recovery). */
  async sendUnblockCode(email: string): Promise<void> {
    await this.request('POST', '/account/login/send_unblock_code', { body: { email } });
  }

  /** Confirm a session with the code from the sign-in email. */
  async verifySessionCode(sessionToken: string, code: string): Promise<void> {
    const hawk = await this.hawkForSession(sessionToken);
    await this.request('POST', '/session/verify_code', { body: { code }, hawk });
  }

  /** Re-send the session confirmation email. */
  async resendSessionCode(sessionToken: string): Promise<void> {
    const hawk = await this.hawkForSession(sessionToken);
    await this.request('POST', '/session/resend_code', { body: {}, hawk });
  }

  /** Confirm a session with a TOTP code from the user's authenticator app. */
  async verifyTotp(sessionToken: string, code: string): Promise<{ success: boolean }> {
    const hawk = await this.hawkForSession(sessionToken);
    return this.request<{ success: boolean }>('POST', '/session/verify/totp', {
      body: { code, service: 'sync' },
      hawk,
    });
  }

  /** Whether this account/session still needs confirmation. */
  async recoveryEmailStatus(sessionToken: string): Promise<RecoveryEmailStatus> {
    const hawk = await this.hawkForSession(sessionToken);
    return this.request<RecoveryEmailStatus>('GET', '/recovery_email/status', { hawk });
  }

  // ---------------------------------------------------------------- key access

  /**
   * `GET /account/keys`, verified and unbundled into kA/kB.
   *
   * The keyFetchToken is single-use: the server invalidates it on success.
   */
  async accountKeys(keyFetchToken: string, unwrapBKey: Uint8Array): Promise<AccountKeys> {
    const creds = await deriveKeyFetchCredentials(fromHex(keyFetchToken));
    const { bundle } = await this.request<AccountKeysResponse>('GET', '/account/keys', {
      hawk: { id: toHex(creds.tokenId), key: creds.reqHMACkey, algorithm: 'sha256' },
    });
    return unbundleAccountKeysHex(creds.requestKey, bundle, unwrapBKey);
  }

  // --------------------------------------------------------------------- OAuth

  /**
   * Trade a sessionToken for OAuth tokens (`grant_type=fxa-credentials`).
   *
   * Pass `keysJwk` to receive the scoped key as a JWE instead of deriving it
   * from kB yourself — that is the path that lets FireSync avoid ever holding
   * the raw master key.
   */
  async createOAuthTokenFromSession(
    sessionToken: string,
    options: {
      scope?: string;
      ttl?: number;
      accessType?: 'online' | 'offline';
      keysJwk?: string;
    } = {},
  ): Promise<OAuthTokenResponse> {
    const hawk = await this.hawkForSession(sessionToken);
    const body: Record<string, unknown> = {
      grant_type: 'fxa-credentials',
      client_id: this.oauthClientId,
      scope: options.scope ?? OLDSYNC_SCOPE,
      access_type: options.accessType ?? 'offline',
    };
    if (options.ttl) body['ttl'] = options.ttl;
    if (options.keysJwk) body['keys_jwk'] = options.keysJwk;
    return this.request<OAuthTokenResponse>('POST', '/oauth/token', { body, hawk });
  }

  /** Exchange an authorization code (the scoped-key OAuth flow). */
  async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<OAuthTokenResponse> {
    return this.request<OAuthTokenResponse>('POST', '/oauth/token', {
      body: {
        grant_type: 'authorization_code',
        client_id: this.oauthClientId,
        code,
        code_verifier: codeVerifier,
      },
    });
  }

  /** Mint a fresh access token. Refresh tokens do not expire on their own. */
  async refreshAccessToken(
    refreshToken: string,
    options: { scope?: string; ttl?: number; clientId?: string } = {},
  ): Promise<OAuthTokenResponse> {
    const body: Record<string, unknown> = {
      grant_type: 'refresh_token',
      // A refresh token belongs to the client it was issued to; presenting it
      // as another client is rejected. Callers that hold a stored token pass
      // the client that issued it rather than trusting this instance's default.
      client_id: options.clientId ?? this.oauthClientId,
      refresh_token: refreshToken,
      scope: options.scope ?? OLDSYNC_SCOPE,
    };
    if (options.ttl) body['ttl'] = options.ttl;
    return this.request<OAuthTokenResponse>('POST', '/oauth/token', { body });
  }

  /** Revoke a refresh token — what "Sign out" should actually do. */
  async destroyOAuthToken(token: string, options: { clientId?: string } = {}): Promise<void> {
    await this.request('POST', '/oauth/destroy', {
      body: { client_id: options.clientId ?? this.oauthClientId, token },
    });
  }

  /**
   * `POST /account/scoped-key-data` — the source of `keyRotationTimestamp`,
   * which is the left half of the `X-KeyID` header.
   */
  async scopedKeyData(
    sessionToken: string,
    scope: string = OLDSYNC_SCOPE,
  ): Promise<ScopedKeyDataResponse> {
    const hawk = await this.hawkForSession(sessionToken);
    return this.request<ScopedKeyDataResponse>('POST', '/account/scoped-key-data', {
      body: { client_id: this.oauthClientId, scope },
      hawk,
    });
  }

  /**
   * `GET /profile` on the profile server, with an OAuth bearer token.
   *
   * The hosted sign-in flow never touches the auth server's session endpoints,
   * so this is the only way it learns who just signed in.
   */
  async profile(accessToken: string): Promise<{ uid: string; email?: string; displayName?: string }> {
    const url = `${this.profileServerUrl}/profile`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    };
    if (this.userAgent) headers['user-agent'] = this.userAgent;

    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers });
    } catch (cause) {
      throw new FxANetworkError(`could not reach ${url}`, cause);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new FxAError(response.status, (safeJsonParse(text) ?? {}) as FxAErrorBody);
    }
    return safeJsonParse(text) as { uid: string; email?: string; displayName?: string };
  }

  // -------------------------------------------------------------------- device

  /** Register FireSync in the user's device list so it can be revoked there. */
  async registerDevice(
    sessionToken: string,
    device: { name: string; type?: string; id?: string },
  ): Promise<DeviceResponse> {
    const hawk = await this.hawkForSession(sessionToken);
    const body: Record<string, unknown> = { name: device.name, type: device.type ?? 'desktop' };
    if (device.id) body['id'] = device.id;
    return this.request<DeviceResponse>('POST', '/account/device', { body, hawk });
  }

  /**
   * Destroy the session token. Call this the moment OAuth tokens are in hand:
   * a sessionToken is full account control, an oldsync refresh token is not.
   */
  async destroySession(sessionToken: string): Promise<void> {
    const hawk = await this.hawkForSession(sessionToken);
    await this.request('POST', '/session/destroy', { body: {}, hawk });
  }

  // ------------------------------------------------------------------ internal

  private async hawkForSession(sessionToken: string): Promise<HawkCredentials> {
    const creds = await deriveSessionCredentials(fromHex(sessionToken));
    return { id: toHex(creds.tokenId), key: creds.reqHMACkey, algorithm: 'sha256' };
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}
