/**
 * The Mozilla token server: trades an FxA OAuth access token for the Hawk
 * credentials and node URL of the user's Sync storage shard.
 *
 *   GET https://token.services.mozilla.com/1.0/sync/1.5
 *   Authorization: Bearer <oldsync access token>
 *   X-KeyID: <keyRotationTimestamp>-<base64url(SHA256(kB)[0:16])>
 *
 * Reference: https://github.com/mozilla-services/tokenserver#readme
 */

import type { FetchLike } from '../fxa/client.ts';

export const DEFAULT_TOKEN_SERVER = 'https://token.services.mozilla.com/1.0/sync/1.5';

export interface TokenServerResponse {
  id: string;
  key: string;
  uid: number;
  api_endpoint: string;
  duration: number;
  hashalg: string;
  hashed_fxa_uid?: string;
  node_type?: string;
}

export interface SyncNodeCredentials extends TokenServerResponse {
  /** Epoch milliseconds after which these credentials must be re-fetched. */
  expiresAt: number;
}

/** The token server rejected our token; the caller should refresh and retry. */
export class TokenServerAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TokenServerAuthError';
  }
}

/** The account has no Sync data yet, or Sync was never enabled on it. */
export class NoSyncAccountError extends Error {
  constructor(message = 'this Mozilla account has no Sync storage provisioned') {
    super(message);
    this.name = 'NoSyncAccountError';
  }
}

export interface FetchNodeOptions {
  accessToken: string;
  keyId: string;
  tokenServerUrl?: string;
  fetchImpl?: FetchLike;
  /** Refresh this many seconds before the server's stated expiry. */
  refreshMarginSec?: number;
}

/** Fetch Hawk credentials + the storage node URL for this account. */
export async function fetchSyncNode(options: FetchNodeOptions): Promise<SyncNodeCredentials> {
  const url = options.tokenServerUrl ?? DEFAULT_TOKEN_SERVER;
  const doFetch = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));

  const response = await doFetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${options.accessToken}`,
      'x-keyid': options.keyId,
      accept: 'application/json',
    },
  });

  if (response.status === 401) {
    throw new TokenServerAuthError(
      'token server rejected the OAuth token (expired, revoked, or wrong X-KeyID)',
      401,
    );
  }
  if (response.status === 404) {
    throw new NoSyncAccountError();
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`token server returned ${response.status}: ${text.slice(0, 300)}`);
  }

  const body = (await response.json()) as TokenServerResponse;
  if (!body.api_endpoint || !body.id || !body.key) {
    throw new Error('token server response is missing id/key/api_endpoint');
  }
  if (body.hashalg && body.hashalg !== 'sha256') {
    throw new Error(`unsupported token server hash algorithm: ${body.hashalg}`);
  }

  const margin = options.refreshMarginSec ?? 300;
  const lifetime = Math.max(0, (body.duration ?? 3600) - margin);
  return { ...body, expiresAt: Date.now() + lifetime * 1000 };
}

/** Whether cached node credentials are still usable. */
export function areNodeCredentialsFresh(
  credentials: SyncNodeCredentials | null | undefined,
): credentials is SyncNodeCredentials {
  return !!credentials && credentials.expiresAt > Date.now();
}
