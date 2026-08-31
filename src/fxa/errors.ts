import type { FxAErrorBody } from './types.ts';
import { FXA_ERRNO } from './types.ts';

/** An error returned by the Firefox Accounts auth server. */
export class FxAError extends Error {
  readonly status: number;
  readonly errno: number | undefined;
  readonly body: FxAErrorBody;

  constructor(status: number, body: FxAErrorBody) {
    super(body.message ?? body.error ?? `Firefox Accounts request failed (${status})`);
    this.name = 'FxAError';
    this.status = status;
    this.errno = body.errno;
    this.body = body;
  }

  /** The account exists but this session still needs an emailed code. */
  get needsSessionVerification(): boolean {
    return this.errno === FXA_ERRNO.UNVERIFIED_SESSION;
  }

  /** The account itself has never been confirmed. */
  get needsAccountVerification(): boolean {
    return this.errno === FXA_ERRNO.UNVERIFIED_ACCOUNT;
  }

  /** Mozilla wants an unblock code emailed to the user (new device / new IP). */
  get needsUnblockCode(): boolean {
    return this.errno === FXA_ERRNO.REQUEST_BLOCKED;
  }

  get isRateLimited(): boolean {
    return this.errno === FXA_ERRNO.TOO_MANY_REQUESTS;
  }

  /** Seconds the server asked us to wait, if it said. */
  get retryAfter(): number | undefined {
    return this.body.retryAfter;
  }

  get isBadPassword(): boolean {
    return (
      this.errno === FXA_ERRNO.INCORRECT_PASSWORD || this.errno === FXA_ERRNO.ACCOUNT_UNKNOWN
    );
  }

  /** The Hawk timestamp was too far from the server's clock. */
  get isClockSkew(): boolean {
    return this.errno === FXA_ERRNO.INVALID_TIMESTAMP;
  }
}

/** A transport-level failure (offline, DNS, TLS). Distinct from FxAError. */
export class FxANetworkError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'FxANetworkError';
  }
}

/**
 * The hosted flow completed, but Mozilla handed back no sync key.
 *
 * Worth its own type because it is the one hosted-flow failure with a remedy:
 * the password flow derives the key locally and does not depend on the content
 * server having key material in the session. The coordinator turns this into a
 * `reason` on the stored result so the UI can offer that route rather than
 * dead-ending on a paragraph of explanation.
 */
export class NoSyncKeyError extends Error {
  /** Whether Mozilla granted `oldsync` at all — the two causes need different words. */
  readonly grantedOldsync: boolean;

  constructor(message: string, grantedOldsync: boolean) {
    super(message);
    this.name = 'NoSyncKeyError';
    this.grantedOldsync = grantedOldsync;
  }
}
