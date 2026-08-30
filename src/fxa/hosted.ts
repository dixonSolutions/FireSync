/**
 * Hosted sign-in — the flow where FireSync never sees the password.
 *
 * The user authenticates on `accounts.firefox.com` itself. Two-factor, recovery
 * keys, passkeys, unblock codes and every future change to how Mozilla
 * authenticates people are Mozilla's problem, not ours. What comes back is an
 * authorization code, which is exchanged for a refresh token and a `keys_jwe`:
 * the 64-byte oldsync key already encrypted to an ephemeral P-256 key that only
 * this extension holds.
 *
 * FireSync therefore never handles:
 *   - the account password,
 *   - a session token (which is full account control),
 *   - the master key `kB`.
 *
 * It holds a refresh token scoped to `oldsync` and the sync key itself, which
 * is the least that can possibly work. The connection appears under
 * accounts.firefox.com → Connected Services and can be revoked there.
 *
 * This is preferred over `ConnectSession` (the password flow), which remains as
 * a fallback.
 */

import { toB64 } from '../common/bytes.ts';
import type { AccountTokens } from '../vault/types.ts';
import {
  DEFAULT_CONTENT_SERVER,
  DEFAULT_HOSTED_CLIENT_ID,
  FxAClient,
  hostedRedirectUri,
} from './client.ts';
import { importEcdhPrivateJwk } from '../common/crypto.ts';
import {
  buildAuthorizationUrl,
  createPkcePair,
  createScopedKeyRequest,
  newState,
  parseRedirect,
  unwrapScopedKeys,
} from './oauth.ts';
import { OLDSYNC_SCOPE } from './onepw.ts';

/** Everything needed to finish a flow that is already in progress. */
export interface PendingHostedSignIn {
  authorizationUrl: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  /** Kept in memory only; it decrypts the scoped-key bundle. */
  privateKeyJwk: JsonWebKey;
  startedAt: number;
}

export interface HostedSignInOptions {
  client?: FxAClient;
  contentServerUrl?: string;
  clientId?: string;
  now?: () => number;
}

export class HostedSignIn {
  private readonly client: FxAClient;
  private readonly contentServerUrl: string;
  private readonly clientId: string;
  private readonly now: () => number;

  constructor(options: HostedSignInOptions = {}) {
    this.clientId = options.clientId ?? DEFAULT_HOSTED_CLIENT_ID;
    this.contentServerUrl = options.contentServerUrl ?? DEFAULT_CONTENT_SERVER;
    this.client =
      options.client ?? new FxAClient({ oauthClientId: this.clientId });
    this.now = options.now ?? (() => Date.now());
  }

  /** Mint PKCE + an ephemeral key pair and build the URL to send the user to. */
  async start(options: { email?: string; forceAccountChooser?: boolean } = {}): Promise<PendingHostedSignIn> {
    const pkce = await createPkcePair();
    const scopedKey = await createScopedKeyRequest();
    const state = newState();
    const redirectUri = hostedRedirectUri(this.clientId, this.contentServerUrl);

    const authorizationUrl = buildAuthorizationUrl({
      contentServerUrl: this.contentServerUrl,
      clientId: this.clientId,
      redirectUri,
      state,
      codeChallenge: pkce.codeChallenge,
      keysJwk: scopedKey.keysJwk,
      scope: `profile ${OLDSYNC_SCOPE}`,
      accessType: 'offline',
      ...(options.email ? { email: options.email } : {}),
      ...(options.forceAccountChooser ? { prompt: 'login' as const } : {}),
    });

    return {
      authorizationUrl,
      redirectUri,
      state,
      codeVerifier: pkce.codeVerifier,
      privateKeyJwk: scopedKey.privateKeyJwk,
      startedAt: this.now(),
    };
  }

  /**
   * Whether a URL the browser navigated to is the redirect we are waiting for.
   * Cheap enough to call on every navigation event; throws only on a genuine
   * failure (an error redirect, or a state mismatch that smells like CSRF).
   */
  matches(url: string, pending: PendingHostedSignIn): boolean {
    return (
      parseRedirect(url, { redirectUri: pending.redirectUri, state: pending.state }) !== null
    );
  }

  /** Exchange the code and unwrap the sync key. */
  async complete(url: string, pending: PendingHostedSignIn): Promise<AccountTokens> {
    const redirect = parseRedirect(url, {
      redirectUri: pending.redirectUri,
      state: pending.state,
    });
    if (!redirect) throw new Error('that URL is not the authorization redirect');

    const tokens = await this.client.exchangeAuthorizationCode(
      redirect.code,
      pending.codeVerifier,
    );

    if (!tokens.refresh_token) {
      throw new Error('Mozilla did not issue a refresh token; sign-in cannot be persisted');
    }
    if (!tokens.keys_jwe) {
      throw new Error(
        'Mozilla did not return the sync key. The OAuth client may not be permitted the ' +
          'oldsync scope with scoped keys.',
      );
    }

    const privateKey = await importEcdhPrivateJwk(pending.privateKeyJwk);
    const { kid, keys } = await unwrapScopedKeys(tokens.keys_jwe, privateKey);

    // The profile server is the only thing that knows who just signed in; this
    // flow never touches the auth server's session endpoints.
    const profile = await this.client
      .profile(tokens.access_token)
      .catch(() => ({ uid: '', email: undefined }));

    return {
      uid: profile.uid ?? '',
      email: profile.email ?? '',
      refreshToken: tokens.refresh_token,
      kSync: toB64(keys.kSync),
      kid,
      connectedAt: this.now(),
    };
  }
}
