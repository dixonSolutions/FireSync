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
import { importAesGcmKey } from '../common/crypto.ts';
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
import { clearDeviceKey, deviceKeyStore, getOrCreateDeviceKey } from './device-key.ts';
import type { DeviceKeyStore } from './device-key.ts';
import {
  checkVerifier,
  deriveVaultKey,
  deriveVaultKeyBytes,
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

export type VaultProtection =
  /** Non-extractable key in IndexedDB. No prompt, no lock screen. Default. */
  | 'device'
  /** Key stretched from a passphrase. Stronger at rest; opt-in in Settings. */
  | 'passphrase';

export interface VaultMeta {
  version: number;
  protection: VaultProtection;
  /** Present only in passphrase mode. */
  kdf?: KdfParams;
  createdAt: number;
}

export interface PasswordMatch {
  record: PasswordRecord;
  score: number;
}

export class VaultStore {
  private readonly local: KeyValueArea;
  private readonly session: KeyValueArea;
  private readonly keyStore: DeviceKeyStore;
  /** In-process cache so one message handler does not decrypt twice. */
  private cachedContents: VaultContents | null = null;

  constructor(areas: StorageAreas, keyStore: DeviceKeyStore = deviceKeyStore) {
    this.local = areas.local;
    this.session = areas.session;
    this.keyStore = keyStore;
  }

  // ---------------------------------------------------------------- lifecycle

  async isInitialized(): Promise<boolean> {
    return (await this.local.get<VaultMeta>(STORAGE_KEY.meta)) !== undefined;
  }

  async protection(): Promise<VaultProtection> {
    return (await this.local.get<VaultMeta>(STORAGE_KEY.meta))?.protection ?? 'device';
  }

  /**
   * Create the vault.
   *
   * With no passphrase this is silent and needs no user input at all — which is
   * the point. `ensure()` calls it lazily, so nothing in the UI has to.
   */
  async create(options: { passphrase?: string; iterations?: number } = {}): Promise<void> {
    if (await this.isInitialized()) {
      throw new Error('vault already exists; call reset() first');
    }

    let meta: VaultMeta;
    let key: CryptoKey;

    if (options.passphrase) {
      const kdf = newKdfParams(options.iterations);
      key = await deriveVaultKey(options.passphrase, kdf);
      meta = { version: VAULT_CONTENTS_VERSION, protection: 'passphrase', kdf, createdAt: Date.now() };
      await this.rememberSessionKey(await deriveVaultKeyBytes(options.passphrase, kdf));
    } else {
      key = await getOrCreateDeviceKey(this.keyStore);
      meta = { version: VAULT_CONTENTS_VERSION, protection: 'device', createdAt: Date.now() };
    }

    await this.local.setMany({
      [STORAGE_KEY.meta]: meta,
      [STORAGE_KEY.verifier]: await makeVerifier(key),
      [STORAGE_KEY.vault]: await seal(key, emptyVaultContents(), SLOT.vault),
      [STORAGE_KEY.sync]: await seal(key, emptySyncState(), SLOT.vault),
    });
    this.cachedContents = emptyVaultContents();
  }

  /** Create the vault if it does not exist yet. Safe to call on every path. */
  async ensure(): Promise<void> {
    if (!(await this.isInitialized())) await this.create();
  }

  /** Verify a passphrase and hold the key for the session. Passphrase mode only. */
  async unlock(passphrase: string): Promise<void> {
    const meta = await this.requireMeta();
    if (meta.protection !== 'passphrase' || !meta.kdf) {
      throw new Error('this vault is not protected by a passphrase');
    }
    const verifier = await this.local.get<SealedBlob>(STORAGE_KEY.verifier);
    if (!verifier) throw new Error('vault verifier is missing; the vault must be reset');

    const key = await deriveVaultKey(passphrase, meta.kdf);
    if (!(await checkVerifier(key, verifier))) throw new WrongPassphraseError();

    await this.rememberSessionKey(await deriveVaultKeyBytes(passphrase, meta.kdf));
    this.cachedContents = null;
  }

  /**
   * Lock the vault. A no-op in device mode: without a passphrase there is
   * nothing to withhold, and a lock screen that any click reopens would be
   * theatre rather than security.
   */
  async lock(): Promise<void> {
    this.cachedContents = null;
    await this.session.remove(STORAGE_KEY.unlocked);
  }

  async isUnlocked(): Promise<boolean> {
    if (!(await this.isInitialized())) return false;
    if ((await this.protection()) === 'device') return true;
    return (await this.session.get<UnlockedState>(STORAGE_KEY.unlocked)) !== undefined;
  }

  /**
   * Switch protection mode, or change the passphrase.
   *
   * Passing null moves back to the device key. Every blob is re-sealed under
   * the new key in one write, so an interrupted change cannot leave half the
   * vault unreadable.
   */
  async setProtection(
    next: { passphrase: string | null; iterations?: number },
    currentPassphrase?: string,
  ): Promise<void> {
    const meta = await this.requireMeta();
    if (meta.protection === 'passphrase') {
      if (!currentPassphrase) throw new Error('the current passphrase is required');
      await this.unlock(currentPassphrase);
    }

    const [contents, tokens, syncState] = await Promise.all([
      this.readContents(),
      this.readTokens(),
      this.readSyncState(),
    ]);

    let key: CryptoKey;
    let nextMeta: VaultMeta;

    if (next.passphrase) {
      const kdf = newKdfParams(next.iterations);
      key = await deriveVaultKey(next.passphrase, kdf);
      nextMeta = { version: VAULT_CONTENTS_VERSION, protection: 'passphrase', kdf, createdAt: Date.now() };
      await this.rememberSessionKey(await deriveVaultKeyBytes(next.passphrase, kdf));
    } else {
      key = await getOrCreateDeviceKey(this.keyStore);
      nextMeta = { version: VAULT_CONTENTS_VERSION, protection: 'device', createdAt: Date.now() };
      await this.session.remove(STORAGE_KEY.unlocked);
    }

    const values: Record<string, unknown> = {
      [STORAGE_KEY.meta]: nextMeta,
      [STORAGE_KEY.verifier]: await makeVerifier(key),
      [STORAGE_KEY.vault]: await seal(key, contents, SLOT.vault),
      [STORAGE_KEY.sync]: await seal(key, syncState, SLOT.vault),
    };
    if (tokens) values[STORAGE_KEY.tokens] = await seal(key, tokens, SLOT.tokens);
    else await this.local.remove(STORAGE_KEY.tokens);

    await this.local.setMany(values);
    this.cachedContents = contents;
  }

  /** Delete everything, including the device key. */
  async reset(): Promise<void> {
    this.cachedContents = null;
    await this.local.remove(Object.values(STORAGE_KEY));
    await this.session.remove(STORAGE_KEY.unlocked);
    await clearDeviceKey(this.keyStore);
  }

  // ------------------------------------------------------------- key handling

  private async requireMeta(): Promise<VaultMeta> {
    const meta = await this.local.get<VaultMeta>(STORAGE_KEY.meta);
    if (!meta) throw new Error('no vault exists yet');
    return meta;
  }

  private async rememberSessionKey(raw: Uint8Array): Promise<void> {
    const state: UnlockedState = { vaultKey: toB64(raw), unlockedAt: Date.now() };
    await this.session.set(STORAGE_KEY.unlocked, state);
  }

  /**
   * The key to seal and unseal with. In device mode this always succeeds; in
   * passphrase mode it throws until the user has unlocked.
   */
  private async requireKey(): Promise<CryptoKey> {
    const meta = await this.requireMeta();
    if (meta.protection === 'device') return getOrCreateDeviceKey(this.keyStore);

    const state = await this.session.get<UnlockedState>(STORAGE_KEY.unlocked);
    if (!state) throw new VaultLockedError();
    return importAesGcmKey(fromB64(state.vaultKey), false);
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
