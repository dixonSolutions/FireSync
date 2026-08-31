/**
 * An end-to-end probe of the Sync connection, stage by stage.
 *
 * Every failure this session — a refresh token presented by the wrong OAuth
 * client, a Hawk signature the storage node rejected, an account that had never
 * synced — surfaced as one sentence in the popup that named no stage. Each of
 * those lives at a different hop, needs a different fix, and looked identical
 * from the outside.
 *
 * So this walks the same path a sync walks and reports each hop separately. It
 * reads nothing and writes nothing: the last step is a HEAD-shaped read of
 * `info/collections`, which is the cheapest request that proves the credentials
 * work against real storage.
 */

import { FxAClient } from '../fxa/client.ts';
import type { FetchLike } from '../fxa/client.ts';
import { OLDSYNC_SCOPE } from '../fxa/onepw.ts';
import type { VaultStore } from '../vault/store.ts';
import { fetchSyncNode } from './tokenserver.ts';
import { SyncStorageClient } from './storage.ts';

export type AuthCheckStage =
  | 'account'
  | 'refresh-token'
  | 'token-server'
  | 'storage-credentials'
  | 'sync-data';

export interface AuthCheckStep {
  stage: AuthCheckStage;
  label: string;
  ok: boolean;
  /** What was learned, or why it failed. Never contains a secret. */
  detail: string;
}

export interface AuthCheckReport {
  ok: boolean;
  steps: AuthCheckStep[];
  checkedAt: number;
}

const LABEL: Record<AuthCheckStage, string> = {
  account: 'Account connected',
  'refresh-token': 'Refresh token accepted by Mozilla',
  'token-server': 'Sync node assigned',
  'storage-credentials': 'Storage credentials accepted',
  'sync-data': 'Sync data present',
};

export interface AuthCheckDeps {
  vault: VaultStore;
  client: FxAClient;
  tokenServerUrl?: string;
  fetchImpl?: FetchLike;
  userAgent?: string;
  now?: () => number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run the probe. Never throws: a failed stage is the result, not an exception. */
export async function runAuthCheck(deps: AuthCheckDeps): Promise<AuthCheckReport> {
  const now = deps.now ?? (() => Date.now());
  const steps: AuthCheckStep[] = [];
  const add = (stage: AuthCheckStage, ok: boolean, detail: string): void => {
    steps.push({ stage, label: LABEL[stage], ok, detail });
  };
  const done = (): AuthCheckReport => ({
    ok: steps.every((step) => step.ok),
    steps,
    checkedAt: now(),
  });

  const tokens = await deps.vault.readTokens().catch(() => null);
  if (!tokens) {
    add('account', false, 'no account is connected — sign in first');
    return done();
  }
  add('account', true, `${tokens.email || 'signed in'} (client ${tokens.clientId ?? 'default'})`);

  let accessToken: string;
  try {
    const refreshed = await deps.client.refreshAccessToken(tokens.refreshToken, {
      scope: OLDSYNC_SCOPE,
      ...(tokens.clientId ? { clientId: tokens.clientId } : {}),
    });
    accessToken = refreshed.access_token;
    add('refresh-token', true, `access token issued for ${refreshed.scope || OLDSYNC_SCOPE}`);
  } catch (error) {
    add(
      'refresh-token',
      false,
      `${message(error)} — the token may have been revoked, or issued to a different OAuth client`,
    );
    return done();
  }

  let node;
  try {
    node = await fetchSyncNode({
      accessToken,
      keyId: tokens.kid,
      ...(deps.tokenServerUrl ? { tokenServerUrl: deps.tokenServerUrl } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    add('token-server', true, new URL(node.api_endpoint).host);
  } catch (error) {
    add('token-server', false, message(error));
    return done();
  }

  const storage = new SyncStorageClient({
    endpoint: node.api_endpoint,
    credentials: { id: node.id, key: node.key, algorithm: 'sha256' },
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.userAgent ? { userAgent: deps.userAgent } : {}),
  });

  let collections: Record<string, number>;
  try {
    collections = await storage.infoCollections();
    add('storage-credentials', true, 'Hawk signature accepted');
  } catch (error) {
    add('storage-credentials', false, message(error));
    return done();
  }

  const names = Object.keys(collections);
  if (names.length === 0) {
    add(
      'sync-data',
      false,
      'the account has never synced — turn on Sync in Firefox and let it upload once',
    );
    return done();
  }
  add('sync-data', true, `${names.length} collections: ${names.sort().join(', ')}`);
  return done();
}
