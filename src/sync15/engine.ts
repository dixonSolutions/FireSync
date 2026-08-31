/**
 * The sync orchestrator: everything between "we have a refresh token" and
 * "the vault matches the server".
 *
 * One `sync()` call:
 *   1. refresh the OAuth access token if needed
 *   2. fetch (or reuse) Hawk credentials + storage node from the token server
 *   3. read `meta/global`, refuse anything but storage version 5, and reset
 *      high-water marks for engines whose syncID changed
 *   4. decrypt `crypto/keys` into the collection key ring
 *   5. per engine: pull records newer than the high-water mark, reconcile,
 *      apply, and upload whatever the local side won
 *
 * Failure policy: one broken engine must not abort the others, and a record
 * that fails HMAC verification is skipped and reported rather than treated as
 * a reason to wipe anything.
 */

import { fromB64 } from '../common/bytes.ts';
import { FxAClient } from '../fxa/client.ts';
import type { FetchLike } from '../fxa/client.ts';
import { OLDSYNC_SCOPE, splitKSync } from '../fxa/onepw.ts';
import type { VaultStore } from '../vault/store.ts';
import type { SyncCollectionName, SyncState } from '../vault/types.ts';
import type { LocalRecord, RemoteRecord } from './reconcile.ts';
import { reconcile } from './reconcile.ts';
import { CollectionKeys, decryptRecord, encryptRecord, RecordCryptoError } from './crypto.ts';
import type { EncryptedPayload, KeyBundle } from './crypto.ts';
import { engineWasReset, parseMetaGlobal, UnsupportedStorageVersionError } from './meta.ts';
import type { MetaGlobal } from './meta.ts';
import {
  ConflictError,
  StorageAuthError,
  SyncNeverEnabledError,
  SyncStorageClient,
  SyncStorageError,
} from './storage.ts';
import type { BasicStorageObject, ServerConfiguration } from './storage.ts';
import { areNodeCredentialsFresh, fetchSyncNode } from './tokenserver.ts';
import type { SyncNodeCredentials } from './tokenserver.ts';
import {
  passwordAuthorityTime,
  PASSWORDS_COLLECTION,
} from './engines/passwords.ts';
import type { PasswordRecord } from './engines/passwords.ts';
import { addressAuthorityTime, ADDRESSES_COLLECTION } from './engines/addresses.ts';
import type { AddressRecord } from './engines/addresses.ts';
import { CREDITCARDS_COLLECTION } from './engines/creditcards.ts';
import type { CreditCardRecord } from './engines/creditcards.ts';

export interface EngineResult {
  collection: string;
  pulled: number;
  pushed: number;
  conflicts: number;
  /** Records the server had that we could not decrypt or validate. */
  skipped: number;
  error?: string;
}

export interface SyncResult {
  ok: boolean;
  startedAt: number;
  finishedAt: number;
  engines: EngineResult[];
  error?: string;
  /** Epoch ms the server asked us not to come back before. */
  backoffUntil?: number;
}

export interface SyncEngineOptions {
  vault: VaultStore;
  client?: FxAClient;
  tokenServerUrl?: string;
  fetchImpl?: FetchLike;
  userAgent?: string;
  now?: () => number;
  /** Which engines to run. Defaults to passwords + addresses. */
  collections?: SyncCollectionName[];
}

interface AuthorityExtractor<T> {
  (record: T): number;
}

const AUTHORITY: Record<SyncCollectionName, AuthorityExtractor<never>> = {
  passwords: passwordAuthorityTime as AuthorityExtractor<never>,
  addresses: addressAuthorityTime as AuthorityExtractor<never>,
  creditcards: ((record: CreditCardRecord) =>
    record.entry?.timeLastModified ?? 0) as AuthorityExtractor<never>,
};

const COLLECTION_NAME: Record<SyncCollectionName, string> = {
  passwords: PASSWORDS_COLLECTION,
  addresses: ADDRESSES_COLLECTION,
  creditcards: CREDITCARDS_COLLECTION,
};

export class SyncEngine {
  private readonly vault: VaultStore;
  private readonly client: FxAClient;
  private readonly tokenServerUrl: string | undefined;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly userAgent: string | undefined;
  private readonly now: () => number;
  private readonly collections: SyncCollectionName[];

  private node: SyncNodeCredentials | null = null;
  private accessToken: { token: string; expiresAt: number } | null = null;
  private serverConfig: ServerConfiguration | null = null;
  private running: Promise<SyncResult> | null = null;

  constructor(options: SyncEngineOptions) {
    this.vault = options.vault;
    this.client = options.client ?? new FxAClient(
      options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
    );
    this.tokenServerUrl = options.tokenServerUrl;
    this.fetchImpl = options.fetchImpl;
    this.userAgent = options.userAgent;
    this.now = options.now ?? (() => Date.now());
    this.collections = options.collections ?? ['passwords', 'addresses'];
  }

  /** Run a sync, coalescing concurrent calls into the one already in flight. */
  async sync(): Promise<SyncResult> {
    if (this.running) return this.running;
    this.running = this.runSync().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runSync(): Promise<SyncResult> {
    const startedAt = this.now();
    const engines: EngineResult[] = [];

    try {
      const storage = await this.storageClient();
      const syncState = await this.vault.readSyncState();

      const info = await storage.infoCollections();
      const meta = await this.readMetaGlobal(storage);
      this.serverConfig ??= await storage.infoConfiguration().catch(() => ({}));

      const keys = await this.readCollectionKeys(storage);

      for (const collection of this.collections) {
        const name = COLLECTION_NAME[collection];
        try {
          engines.push(
            await this.syncCollection(storage, keys, meta, syncState, collection, info[name]),
          );
        } catch (error) {
          engines.push({
            collection: name,
            pulled: 0,
            pushed: 0,
            conflicts: 0,
            skipped: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      syncState.lastSyncAt = this.now();
      syncState.lastSyncError = engines.find((engine) => engine.error)?.error ?? null;
      syncState.metaGlobalSyncId = meta.syncID;
      await this.vault.writeSyncState(syncState);

      const result: SyncResult = {
        ok: engines.every((engine) => !engine.error),
        startedAt,
        finishedAt: this.now(),
        engines,
      };
      if (storage.backoffUntilMs > this.now()) result.backoffUntil = storage.backoffUntilMs;
      return result;
    } catch (error) {
      if (error instanceof StorageAuthError) {
        // Force a fresh token server round-trip on the next attempt.
        this.node = null;
        this.accessToken = null;
      }
      const message = error instanceof Error ? error.message : String(error);
      const syncState = await this.vault.readSyncState().catch(() => null);
      if (syncState) {
        syncState.lastSyncError = message;
        await this.vault.writeSyncState(syncState).catch(() => undefined);
      }
      return {
        ok: false,
        startedAt,
        finishedAt: this.now(),
        engines,
        error: message,
      };
    }
  }

  // ------------------------------------------------------------ session setup

  /** A ready-to-use storage client, refreshing credentials as needed. */
  private async storageClient(): Promise<SyncStorageClient> {
    const tokens = await this.vault.readTokens();
    if (!tokens) throw new Error('no Mozilla account is connected');

    if (!this.accessToken || this.accessToken.expiresAt <= this.now()) {
      const refreshed = await this.client.refreshAccessToken(tokens.refreshToken, {
        scope: OLDSYNC_SCOPE,
        // The hosted flow and the password flow use different OAuth clients, and
        // this engine's client is configured with neither in particular. Refresh
        // as whoever the token was actually issued to.
        ...(tokens.clientId ? { clientId: tokens.clientId } : {}),
      });
      this.accessToken = {
        token: refreshed.access_token,
        // Refresh a minute early; a token that expires mid-sync costs a retry.
        expiresAt: this.now() + Math.max(0, refreshed.expires_in - 60) * 1000,
      };
      this.node = null;
    }

    if (!areNodeCredentialsFresh(this.node)) {
      this.node = await fetchSyncNode({
        accessToken: this.accessToken.token,
        keyId: tokens.kid,
        ...(this.tokenServerUrl ? { tokenServerUrl: this.tokenServerUrl } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      });
    }

    return new SyncStorageClient({
      endpoint: this.node.api_endpoint,
      credentials: { id: this.node.id, key: this.node.key, algorithm: 'sha256' },
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.userAgent ? { userAgent: this.userAgent } : {}),
    });
  }

  private async readMetaGlobal(storage: SyncStorageClient): Promise<MetaGlobal> {
    let bso;
    try {
      bso = await storage.getRecord('meta', 'global');
    } catch (error) {
      // `meta/global` is written by the first browser that turns Sync on. A 404
      // is therefore not a failure of this request but a statement about the
      // account: nothing has ever synced to it. Reported as a raw HTTP status
      // it reads like a bug in FireSync, and sends people looking in the wrong
      // place for something only Firefox can create.
      if (error instanceof SyncStorageError && error.status === 404) {
        throw new SyncNeverEnabledError();
      }
      throw error;
    }
    try {
      return parseMetaGlobal(JSON.parse(bso.payload));
    } catch (error) {
      if (error instanceof UnsupportedStorageVersionError) throw error;
      throw new Error(`could not read meta/global: ${String(error)}`);
    }
  }

  private async readCollectionKeys(storage: SyncStorageClient): Promise<CollectionKeys> {
    const tokens = await this.vault.readTokens();
    if (!tokens) throw new Error('no Mozilla account is connected');
    const syncKeys = splitKSync(fromB64(tokens.kSync));
    const bundle: KeyBundle = { encKey: syncKeys.encKey, hmacKey: syncKeys.hmacKey };
    const { payload } = await storage.getEncryptedRecord('crypto', 'keys');
    return CollectionKeys.fromEncrypted(bundle, payload);
  }

  // -------------------------------------------------------------- per-engine

  private async syncCollection(
    storage: SyncStorageClient,
    keys: CollectionKeys,
    meta: MetaGlobal,
    syncState: SyncState,
    collection: SyncCollectionName,
    serverLastModified: number | undefined,
  ): Promise<EngineResult> {
    const name = COLLECTION_NAME[collection];
    const bundle = keys.forCollection(name);
    const state = (syncState.collections[name] ??= { lastModified: null, syncId: null });

    // An engine reset on the Firefox side invalidates every marker we hold.
    const remoteSyncId = meta.engines[name]?.syncID ?? null;
    if (engineWasReset(meta, name, state.syncId)) {
      state.lastModified = null;
    }
    state.syncId = remoteSyncId;

    const result: EngineResult = {
      collection: name,
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      skipped: 0,
    };

    // ---- pull -------------------------------------------------------------
    const remote: RemoteRecord<unknown>[] = [];
    const serverHasChanges =
      serverLastModified !== undefined &&
      (state.lastModified === null || serverLastModified > state.lastModified);

    let highWaterMark = state.lastModified;

    if (serverHasChanges) {
      const { records, lastModified } = await storage.getAllRecords(name, {
        full: true,
        ...(state.lastModified !== null ? { newer: state.lastModified } : {}),
      });
      if (lastModified !== null) highWaterMark = lastModified;

      for (const bso of records) {
        const decoded = await this.decodeRecord(bundle, bso, collection);
        if (!decoded) {
          result.skipped += 1;
          continue;
        }
        remote.push(decoded);
      }
    }

    // ---- reconcile --------------------------------------------------------
    const local = await this.vault.localRecords<unknown>(collection);
    const plan = reconcile(local, remote);
    result.conflicts = plan.conflicts.length;

    if (plan.applyLocally.length) {
      await this.vault.applyRemote(
        collection,
        plan.applyLocally.map((record) => ({
          id: record.id,
          data: record.data,
          deleted: record.deleted,
          authorityTime: record.authorityTime,
          syncedAt: record.modified,
          dirty: false,
        })),
      );
      result.pulled = plan.applyLocally.length;
    }

    // ---- push -------------------------------------------------------------
    if (plan.uploadRemotely.length) {
      const bsos: BasicStorageObject[] = [];
      for (const record of plan.uploadRemotely) {
        const payload = record.deleted
          ? { id: record.id, deleted: true }
          : (record.data as Record<string, unknown>);
        const encrypted = await encryptRecord(bundle, payload);
        bsos.push({ id: record.id, payload: JSON.stringify(encrypted) });
      }

      try {
        // The precondition must be the timestamp we just READ at, not the one
        // from the previous sync: we have already reconciled against every
        // change up to `highWaterMark`, and using the older value would 412 on
        // every run that both pulls and pushes.
        const uploaded = await storage.postRecordsBatched(name, bsos, {
          ...(highWaterMark !== null ? { unmodifiedSince: highWaterMark } : {}),
          ...(this.serverConfig ? { config: this.serverConfig } : {}),
        });
        result.pushed = uploaded.success.length;
        if (uploaded.modified !== null) highWaterMark = uploaded.modified;
        await this.vault.markSynced(collection, uploaded.success, uploaded.modified ?? 0);
        if (Object.keys(uploaded.failed).length) {
          result.error = `server rejected ${Object.keys(uploaded.failed).length} record(s)`;
        }
      } catch (error) {
        if (error instanceof ConflictError) {
          // Someone wrote while we were deciding. Do not clobber: drop the
          // high-water mark so the next pass re-reads and re-reconciles.
          state.lastModified = null;
          result.error = 'collection changed mid-sync; will re-reconcile on the next run';
          return result;
        }
        throw error;
      }
    }

    state.lastModified = highWaterMark;
    return result;
  }

  /** Decrypt + validate one BSO into a `RemoteRecord`, or null to skip it. */
  private async decodeRecord(
    bundle: KeyBundle,
    bso: BasicStorageObject,
    collection: SyncCollectionName,
  ): Promise<RemoteRecord<unknown> | null> {
    let payload: EncryptedPayload;
    try {
      payload = JSON.parse(bso.payload) as EncryptedPayload;
    } catch {
      return null;
    }

    let value: Record<string, unknown>;
    try {
      value = await decryptRecord<Record<string, unknown>>(bundle, payload, bso.id);
    } catch (error) {
      if (error instanceof RecordCryptoError) return null;
      throw error;
    }

    const deleted = value['deleted'] === true;
    const authority = deleted
      ? (bso.modified ?? 0) * 1000
      : (AUTHORITY[collection] as (record: unknown) => number)(value);

    return {
      id: bso.id,
      data: deleted ? null : (value as unknown),
      deleted,
      modified: bso.modified ?? 0,
      authorityTime: authority,
    };
  }
}

/** Narrow helper used by the popup to describe the last sync in one line. */
export function describeSyncResult(result: SyncResult): string {
  if (!result.ok) return result.error ?? 'sync failed';
  const pulled = result.engines.reduce((sum, engine) => sum + engine.pulled, 0);
  const pushed = result.engines.reduce((sum, engine) => sum + engine.pushed, 0);
  const skipped = result.engines.reduce((sum, engine) => sum + engine.skipped, 0);
  const parts = [`${pulled} in`, `${pushed} out`];
  if (skipped) parts.push(`${skipped} unreadable`);
  return parts.join(', ');
}

export type { PasswordRecord, AddressRecord };
