/**
 * The sign-in state machine.
 *
 * Signing in to a Mozilla account is not one request. Depending on the
 * account's configuration and Mozilla's risk signals it can require a TOTP
 * code, an emailed session code, or a "sign-in unblock" code — and the
 * keyFetchToken must not be spent until the session is actually verified,
 * because it is single-use.
 *
 * `ConnectSession` models that as an explicit step machine so the UI never has
 * to guess, and so the whole flow is testable against a scripted fetch.
 */

import { toB64 } from '../common/bytes.ts';
import type { AccountTokens } from '../vault/types.ts';
import { FxAClient } from './client.ts';
import { FxAError } from './errors.ts';
import { deriveKeyId, deriveSyncKeys, OLDSYNC_SCOPE } from './onepw.ts';
import type { SignInResponse } from './types.ts';

export type ConnectStep =
  | { kind: 'complete'; account: AccountTokens }
  | { kind: 'needs-totp' }
  | { kind: 'needs-email-code'; email: string }
  | { kind: 'needs-unblock-code'; email: string };

export interface ConnectSessionOptions {
  client?: FxAClient;
  /** Shown in the user's Mozilla account device list. */
  deviceName?: string;
  /** Register a device record so the connection is revocable from Mozilla. */
  registerDevice?: boolean;
  now?: () => number;
}

export class ConnectSession {
  private readonly client: FxAClient;
  private readonly deviceName: string;
  private readonly shouldRegisterDevice: boolean;
  private readonly now: () => number;

  private email: string | null = null;
  private sessionToken: string | null = null;
  private keyFetchToken: string | null = null;
  private unwrapBKey: Uint8Array | null = null;
  private uid: string | null = null;

  constructor(options: ConnectSessionOptions = {}) {
    this.client = options.client ?? new FxAClient();
    this.deviceName = options.deviceName ?? 'FireSync';
    this.shouldRegisterDevice = options.registerDevice ?? true;
    this.now = options.now ?? (() => Date.now());
  }

  /** Step 1: email + password. */
  async begin(email: string, password: string, unblockCode?: string): Promise<ConnectStep> {
    this.email = email;
    let result: { response: SignInResponse; unwrapBKey: Uint8Array };
    try {
      result = await this.client.signIn(email, password, {
        keys: true,
        reason: 'login',
        ...(unblockCode ? { unblockCode } : {}),
      });
    } catch (error) {
      if (error instanceof FxAError && error.needsUnblockCode) {
        await this.client.sendUnblockCode(email).catch(() => undefined);
        return { kind: 'needs-unblock-code', email };
      }
      throw error;
    }

    const { response, unwrapBKey } = result;
    this.sessionToken = response.sessionToken;
    this.keyFetchToken = response.keyFetchToken ?? null;
    this.unwrapBKey = unwrapBKey;
    this.uid = response.uid;

    if (!this.keyFetchToken) {
      throw new Error('the auth server did not return a keyFetchToken; cannot access Sync');
    }

    if (response.verified) return this.finish();

    if (response.verificationMethod === 'totp-2fa') return { kind: 'needs-totp' };
    return { kind: 'needs-email-code', email };
  }

  /** Step 2a: a code from the user's authenticator app. */
  async submitTotp(code: string): Promise<ConnectStep> {
    const sessionToken = this.requireSessionToken();
    const { success } = await this.client.verifyTotp(sessionToken, code);
    if (!success) throw new Error('that two-factor code was not accepted');
    return this.finish();
  }

  /** Step 2b: a code from the sign-in confirmation email. */
  async submitEmailCode(code: string): Promise<ConnectStep> {
    const sessionToken = this.requireSessionToken();
    await this.client.verifySessionCode(sessionToken, code);
    return this.finish();
  }

  /** Ask Mozilla to send the confirmation email again. */
  async resendEmailCode(): Promise<void> {
    await this.client.resendSessionCode(this.requireSessionToken());
  }

  /**
   * Step 3: with a verified session, spend the keyFetchToken, mint OAuth
   * tokens, and throw the session token away.
   */
  private async finish(): Promise<ConnectStep> {
    const sessionToken = this.requireSessionToken();
    if (!this.keyFetchToken || !this.unwrapBKey || !this.uid || !this.email) {
      throw new Error('connect session is missing state; start again');
    }

    const { kB } = await this.client.accountKeys(this.keyFetchToken, this.unwrapBKey);
    this.keyFetchToken = null;

    const scopedKeyData = await this.client.scopedKeyData(sessionToken, OLDSYNC_SCOPE);
    const entry = scopedKeyData[OLDSYNC_SCOPE];
    if (!entry) {
      throw new Error(
        `this OAuth client is not authorised for ${OLDSYNC_SCOPE}; see docs/PROTOCOL.md`,
      );
    }

    const tokenResponse = await this.client.createOAuthTokenFromSession(sessionToken, {
      scope: OLDSYNC_SCOPE,
      accessType: 'offline',
    });
    if (!tokenResponse.refresh_token) {
      throw new Error('the auth server did not issue a refresh token');
    }

    let deviceId: string | undefined;
    if (this.shouldRegisterDevice) {
      // Best effort: a failure here costs the user a device-list entry, not
      // their sync.
      deviceId = await this.client
        .registerDevice(sessionToken, { name: this.deviceName, type: 'desktop' })
        .then((device) => device.id)
        .catch(() => undefined);
    }

    const syncKeys = await deriveSyncKeys(kB);
    const kid = await deriveKeyId(kB, entry.keyRotationTimestamp);

    // The session token is full account control and we no longer need it.
    await this.client.destroySession(sessionToken).catch(() => undefined);
    this.sessionToken = null;
    this.unwrapBKey = null;
    kB.fill(0);

    const account: AccountTokens = {
      uid: this.uid,
      email: this.email,
      refreshToken: tokenResponse.refresh_token,
      kSync: toB64(syncKeys.kSync),
      kid,
      ...(deviceId ? { deviceId } : {}),
      connectedAt: this.now(),
    };
    return { kind: 'complete', account };
  }

  private requireSessionToken(): string {
    if (!this.sessionToken) throw new Error('no active sign-in; call begin() first');
    return this.sessionToken;
  }
}
