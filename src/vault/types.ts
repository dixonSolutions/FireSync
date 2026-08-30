import type { LocalRecord } from '../sync15/reconcile.ts';
import type { PasswordRecord } from '../sync15/engines/passwords.ts';
import type { AddressRecord } from '../sync15/engines/addresses.ts';
import type { CreditCardRecord } from '../sync15/engines/creditcards.ts';

export const VAULT_CONTENTS_VERSION = 1;

/** Everything the vault holds, in decrypted form. Never touches disk like this. */
export interface VaultContents {
  version: number;
  passwords: Record<string, LocalRecord<PasswordRecord>>;
  addresses: Record<string, LocalRecord<AddressRecord>>;
  creditcards: Record<string, LocalRecord<CreditCardRecord>>;
}

export function emptyVaultContents(): VaultContents {
  return { version: VAULT_CONTENTS_VERSION, passwords: {}, addresses: {}, creditcards: {} };
}

export type SyncCollectionName = 'passwords' | 'addresses' | 'creditcards';

/** Per-collection high-water marks. Reset when an engine's syncID changes. */
export interface CollectionSyncState {
  lastModified: number | null;
  syncId: string | null;
}

export interface SyncState {
  lastSyncAt: number | null;
  lastSyncError: string | null;
  metaGlobalSyncId: string | null;
  collections: Record<string, CollectionSyncState>;
}

export function emptySyncState(): SyncState {
  return { lastSyncAt: null, lastSyncError: null, metaGlobalSyncId: null, collections: {} };
}

/** Long-lived account material. Sealed alongside the vault, never in session only. */
export interface AccountTokens {
  uid: string;
  email: string;
  /** OAuth refresh token — the only long-lived secret we keep. */
  refreshToken: string;
  /** base64 of the 64-byte oldsync key. */
  kSync: string;
  /** `<keyRotationTimestamp>-<base64url fingerprint>` for the X-KeyID header. */
  kid: string;
  /** Registered FxA device id, if we registered one. */
  deviceId?: string;
  connectedAt: number;
}

/** Short-lived material that lives only in `chrome.storage.session`. */
export interface UnlockedState {
  /** base64 of the 32-byte vault key. */
  vaultKey: string;
  unlockedAt: number;
}
