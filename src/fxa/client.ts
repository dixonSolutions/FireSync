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

/**
 * Firefox Accounts has no self-serve OAuth client registration. Third-party
 * Sync clients reuse a Mozilla *public* client id (public by construction —
 * it ships inside every Firefox binary). This is unsanctioned and Mozilla may
 * gate it at any time, which is exactly why it is configuration and not a
 * hardcoded constant: see docs/PROTOCOL.md#oauth-client-identity.
 */
export const DEFAULT_OAUTH_CLIENT_ID = '5882386c6d801776';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FxAClientOptions {
  authServerUrl?: string;
  contentServerUrl?: string;
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
    options: { scope?: string; ttl?: number } = {},
  ): Promise<OAuthTokenResponse> {
    const body: Record<string, unknown> = {
      grant_type: 'refresh_token',
      client_id: this.oauthClientId,
      refresh_token: refreshToken,
      scope: options.scope ?? OLDSYNC_SCOPE,
    };
    if (options.ttl) body['ttl'] = options.ttl;
    return this.request<OAuthTokenResponse>('POST', '/oauth/token', { body });
  }

  /** Revoke a refresh token — what "Sign out" should actually do. */
  async destroyOAuthToken(token: string): Promise<void> {
    await this.request('POST', '/oauth/destroy', {
      body: { client_id: this.oauthClientId, token },
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
