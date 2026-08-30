/**
 * The local vault: encrypted-at-rest credential storage plus the sync
 * bookkeeping that goes with it.
 *
 * Layout in `chrome.storage.local` (all values are sealed blobs except `meta`):
 *
 *   firesync.meta      { version, kdf, createdAt }          plaintext, no secrets
 *   firesync.verifier  SealedBlob                           fast passphrase check
 *   firesync.vault     SealedBlob -> VaultContents
 *   firesync.tokens    SealedBlob -> AccountTokens
 *   firesync.sync      SealedBlob -> SyncState
 *
 * In `chrome.storage.session` (memory only):
 *
 *   firesync.unlocked  { vaultKey (base64), unlockedAt }
 */

import { fromB64, toB64 } from '../common/bytes.ts';
import type { KeyValueArea, StorageAreas } from '../common/storage.ts';
import type { LocalRecord } from '../sync15/reconcile.ts';
import type { PasswordRecord } from '../sync15/engines/passwords.ts';
import {
  changePassword,
  markPasswordUsed,
  newPasswordRecord,
  passwordAuthorityTime,
} from '../sync15/engines/passwords.ts';
import type { NewPasswordInput } from '../sync15/engines/passwords.ts';
import { matchScore, originMatches } from '../match/uri.ts';
import type { MatchContext } from '../match/uri.ts';
import {
  checkVerifier,
  deriveVaultKey,
  makeVerifier,
  newKdfParams,
  seal,
  unseal,
  SLOT,
  VaultLockedError,
  WrongPassphraseError,
} from './crypto.ts';
import type { KdfParams, SealedBlob } from './crypto.ts';
import {
  emptySyncState,
  emptyVaultContents,
  VAULT_CONTENTS_VERSION,
} from './types.ts';
import type {
  AccountTokens,
  SyncCollectionName,
  SyncState,
  UnlockedState,
  VaultContents,
} from './types.ts';

export const STORAGE_KEY = {
  meta: 'firesync.meta',
  verifier: 'firesync.verifier',
  vault: 'firesync.vault',
  tokens: 'firesync.tokens',
  sync: 'firesync.sync',
  unlocked: 'firesync.unlocked',
} as const;

export interface VaultMeta {
  version: number;
  kdf: KdfParams;
  createdAt: number;
}

export interface PasswordMatch {
  record: PasswordRecord;
  score: number;
}

export class VaultStore {
  private readonly local: KeyValueArea;
  private readonly session: KeyValueArea;
  /** In-process cache so a single message handler does not re-derive/decrypt. */
  private cachedContents: VaultContents | null = null;

  constructor(areas: StorageAreas) {
    this.local = areas.local;
    this.session = areas.session;
  }

  // ---------------------------------------------------------------- lifecycle

  async isInitialized(): Promise<boolean> {
    return (await this.local.get<VaultMeta>(STORAGE_KEY.meta)) !== undefined;
  }

  /** Create a brand new empty vault protected by `passphrase`. */
  async create(passphrase: string, iterations?: number): Promise<void> {
    if (await this.isInitialized()) {
      throw new Error('vault already exists; call reset() first');
    }
    const kdf = newKdfParams(iterations);
    const key = await deriveVaultKey(passphrase, kdf);
    const meta: VaultMeta = { version: VAULT_CONTENTS_VERSION, kdf, createdAt: Date.now() };

    await this.local.setMany({
      [STORAGE_KEY.meta]: meta,
      [STORAGE_KEY.verifier]: await makeVerifier(key),
      [STORAGE_KEY.vault]: await seal(key, emptyVaultContents(), SLOT.vault),
      [STORAGE_KEY.sync]: await seal(key, emptySyncState(), SLOT.vault),
    });
    await this.setSessionKey(key);
    this.cachedContents = emptyVaultContents();
  }

  /** Verify the passphrase and hold the derived key in session storage. */
  async unlock(passphrase: string): Promise<void> {
    const meta = await this.local.get<VaultMeta>(STORAGE_KEY.meta);
    if (!meta) throw new Error('no vault to unlock');
    const verifier = await this.local.get<SealedBlob>(STORAGE_KEY.verifier);
    if (!verifier) throw new Error('vault verifier is missing; the vault must be reset');

    const key = await deriveVaultKey(passphrase, meta.kdf);
    if (!(await checkVerifier(key, verifier))) throw new WrongPassphraseError();
    await this.setSessionKey(key);
    this.cachedContents = null;
  }

  /** Drop the key from memory and session storage. */
  async lock(): Promise<void> {
    this.cachedContents = null;
    await this.session.remove(STORAGE_KEY.unlocked);
  }

  async isUnlocked(): Promise<boolean> {
    return (await this.session.get<UnlockedState>(STORAGE_KEY.unlocked)) !== undefined;
  }

  /** Change the passphrase, re-sealing every blob under the new key. */
  async changePassphrase(current: string, next: string): Promise<void> {
    await this.unlock(current);
    const [contents, tokens, syncState] = await Promise.all([
      this.readContents(),
      this.readTokens(),
      this.readSyncState(),
    ]);

    const kdf = newKdfParams();
    const key = await deriveVaultKey(next, kdf);
    const meta: VaultMeta = { version: VAULT_CONTENTS_VERSION, kdf, createdAt: Date.now() };

    const values: Record<string, unknown> = {
      [STORAGE_KEY.meta]: meta,
      [STORAGE_KEY.verifier]: await makeVerifier(key),
      [STORAGE_KEY.vault]: await seal(key, contents, SLOT.vault),
      [STORAGE_KEY.sync]: await seal(key, syncState, SLOT.vault),
    };
    if (tokens) values[STORAGE_KEY.tokens] = await seal(key, tokens, SLOT.tokens);

    await this.local.setMany(values);
    await this.setSessionKey(key);
  }

  /** Delete everything. Used by "Disconnect account" and by tests. */
  async reset(): Promise<void> {
    this.cachedContents = null;
    await this.local.remove(Object.values(STORAGE_KEY));
    await this.session.remove(STORAGE_KEY.unlocked);
  }

  // ------------------------------------------------------------- key handling

  private async setSessionKey(key: Uint8Array): Promise<void> {
    const state: UnlockedState = { vaultKey: toB64(key), unlockedAt: Date.now() };
    await this.session.set(STORAGE_KEY.unlocked, state);
  }

  /** The unlocked key, or throw. Every read/write funnels through here. */
  private async requireKey(): Promise<Uint8Array> {
    const state = await this.session.get<UnlockedState>(STORAGE_KEY.unlocked);
    if (!state) throw new VaultLockedError();
    return fromB64(state.vaultKey);
  }

  // ----------------------------------------------------------------- contents

  async readContents(): Promise<VaultContents> {
    if (this.cachedContents) return this.cachedContents;
    const key = await this.requireKey();
    const blob = await this.local.get<SealedBlob>(STORAGE_KEY.vault);
    const contents = blob
      ? await unseal<VaultContents>(key, blob, SLOT.vault)
      : emptyVaultContents();
    this.cachedContents = contents;
    return contents;
  }

  async writeContents(contents: VaultContents): Promise<void> {
    const key = await this.requireKey();
    this.cachedContents = contents;
    await this.local.set(STORAGE_KEY.vault, await seal(key, contents, SLOT.vault));
  }

  async readTokens(): Promise<AccountTokens | null> {
    const key = await this.requireKey();
    const blob = await this.local.get<SealedBlob>(STORAGE_KEY.tokens);
    return blob ? unseal<AccountTokens>(key, blob, SLOT.tokens) : null;
  }

  async writeTokens(tokens: AccountTokens): Promise<void> {
    const key = await this.requireKey();
    await this.local.set(STORAGE_KEY.tokens, await seal(key, tokens, SLOT.tokens));
  }

  async clearTokens(): Promise<void> {
    await this.local.remove(STORAGE_KEY.tokens);
  }

  async readSyncState(): Promise<SyncState> {
    const key = await this.requireKey();
    const blob = await this.local.get<SealedBlob>(STORAGE_KEY.sync);
    return blob ? unseal<SyncState>(key, blob, SLOT.vault) : emptySyncState();
  }

  async writeSyncState(state: SyncState): Promise<void> {
    const key = await this.requireKey();
    await this.local.set(STORAGE_KEY.sync, await seal(key, state, SLOT.vault));
  }

  // ---------------------------------------------------------------- passwords

  async listPasswords(): Promise<PasswordRecord[]> {
    const contents = await this.readContents();
    return Object.values(contents.passwords)
      .filter((record) => !record.deleted && record.data)
      .map((record) => record.data as PasswordRecord);
  }

  async getPassword(id: string): Promise<PasswordRecord | null> {
    const contents = await this.readContents();
    const record = contents.passwords[id];
    return record && !record.deleted ? record.data : null;
  }

  /**
   * Credentials that may be offered on `pageUrl`, best match first.
   *
   * `context` carries the per-site match strategy, so a user who has pinned a
   * site to `host` matching does not get eTLD+1 behaviour behind their back.
   */
  async findPasswordsForUrl(
    pageUrl: string,
    context: MatchContext = {},
  ): Promise<PasswordMatch[]> {
    const records = await this.listPasswords();
    return records
      .filter((record) => originMatches(record.hostname, pageUrl, context))
      .map((record) => ({ record, score: matchScore(record.hostname, pageUrl) }))
      .sort((a, b) => b.score - a.score || a.record.username.localeCompare(b.record.username));
  }

  /** Add a credential and mark it for upload. */
  async addPassword(input: NewPasswordInput): Promise<PasswordRecord> {
    const record = newPasswordRecord(input);
    const contents = await this.readContents();
    contents.passwords[record.id] = {
      id: record.id,
      data: record,
      deleted: false,
      authorityTime: passwordAuthorityTime(record),
      syncedAt: null,
      dirty: true,
    };
    await this.writeContents(contents);
    return record;
  }

  /** Replace a credential's password, moving its conflict authority forward. */
  async updatePassword(id: string, password: string): Promise<PasswordRecord> {
    const contents = await this.readContents();
    const existing = contents.passwords[id];
    if (!existing?.data) throw new Error(`no password with id ${id}`);
    const updated = changePassword(existing.data, password);
    contents.passwords[id] = {
      ...existing,
      data: updated,
      authorityTime: passwordAuthorityTime(updated),
      dirty: true,
    };
    await this.writeContents(contents);
    return updated;
  }

  /** Patch arbitrary fields (username, form field names, notes on the origin). */
  async patchPassword(id: string, patch: Partial<PasswordRecord>): Promise<PasswordRecord> {
    const contents = await this.readContents();
    const existing = contents.passwords[id];
    if (!existing?.data) throw new Error(`no password with id ${id}`);
    const updated: PasswordRecord = { ...existing.data, ...patch, id };
    contents.passwords[id] = {
      ...existing,
      data: updated,
      authorityTime: passwordAuthorityTime(updated),
      dirty: true,
    };
    await this.writeContents(contents);
    return updated;
  }

  /** Record a successful fill, the way Firefox does. */
  async touchPassword(id: string): Promise<void> {
    const contents = await this.readContents();
    const existing = contents.passwords[id];
    if (!existing?.data) return;
    const updated = markPasswordUsed(existing.data);
    // A usage bump is not a password change: the authority time stays put so
    // merely filling a login never wins a conflict against a real edit.
    contents.passwords[id] = { ...existing, data: updated, dirty: true };
    await this.writeContents(contents);
  }

  /** Tombstone a credential so the deletion propagates to Firefox. */
  async deletePassword(id: string): Promise<void> {
    const contents = await this.readContents();
    const existing = contents.passwords[id];
    if (!existing) return;
    contents.passwords[id] = {
      id,
      data: null,
      deleted: true,
      authorityTime: Date.now(),
      syncedAt: existing.syncedAt,
      dirty: true,
    };
    await this.writeContents(contents);
  }

  // ------------------------------------------------------------- sync support

  /** The local view of a collection, in the shape `reconcile()` expects. */
  async localRecords<T>(collection: SyncCollectionName): Promise<LocalRecord<T>[]> {
    const contents = await this.readContents();
    return Object.values(contents[collection]) as unknown as LocalRecord<T>[];
  }

  /** Overwrite local records with versions the server won. */
  async applyRemote<T>(
    collection: SyncCollectionName,
    records: readonly LocalRecord<T>[],
  ): Promise<void> {
    const contents = await this.readContents();
    const target = contents[collection] as unknown as Record<string, LocalRecord<T>>;
    for (const record of records) target[record.id] = record;
    await this.writeContents(contents);
  }

  /** Clear the dirty flag for records the server has accepted. */
  async markSynced(
    collection: SyncCollectionName,
    ids: readonly string[],
    serverModified: number,
  ): Promise<void> {
    const contents = await this.readContents();
    const target = contents[collection] as unknown as Record<string, LocalRecord<unknown>>;
    for (const id of ids) {
      const record = target[id];
      if (record) target[id] = { ...record, dirty: false, syncedAt: serverModified };
    }
    await this.writeContents(contents);
  }

  /** Permanently drop tombstones both sides have agreed on. */
  async purgeRecords(collection: SyncCollectionName, ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    const contents = await this.readContents();
    const target = contents[collection] as unknown as Record<string, unknown>;
    for (const id of ids) delete target[id];
    await this.writeContents(contents);
  }

  /** Counts for the popup header. Cheap enough to call on every render. */
  async stats(): Promise<{ passwords: number; addresses: number; pendingUploads: number }> {
    const contents = await this.readContents();
    const pending = (Object.values(contents.passwords) as LocalRecord<unknown>[])
      .concat(Object.values(contents.addresses) as LocalRecord<unknown>[])
      .filter((record) => record.dirty).length;
    return {
      passwords: Object.values(contents.passwords).filter((r) => !r.deleted).length,
      addresses: Object.values(contents.addresses).filter((r) => !r.deleted).length,
      pendingUploads: pending,
    };
  }
}
