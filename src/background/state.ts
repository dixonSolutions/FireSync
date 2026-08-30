/**
 * Lazily-constructed singletons for the service worker.
 *
 * An MV3 service worker is killed after ~30 seconds of inactivity and this
 * module is re-evaluated from scratch when it wakes. Nothing here may assume it
 * survived; every getter rebuilds on demand, and all durable state lives in
 * `chrome.storage`.
 */

import { chromeStorageAreas } from '../common/storage.ts';
import type { StorageAreas } from '../common/storage.ts';
import { FxAClient } from '../fxa/client.ts';
import { PreferencesStore } from '../prefs/store.ts';
import { SyncEngine } from '../sync15/engine.ts';
import { UpdateChecker } from '../update/checker.ts';
import { VaultStore } from '../vault/store.ts';

export const USER_AGENT = 'FireSync/0.1 (+https://github.com/firesync/firesync)';

let areas: StorageAreas | null = null;
let vault: VaultStore | null = null;
let prefs: PreferencesStore | null = null;
let fxa: FxAClient | null = null;
let engine: SyncEngine | null = null;
let updates: UpdateChecker | null = null;

export function getAreas(): StorageAreas {
  return (areas ??= chromeStorageAreas());
}

export function getVault(): VaultStore {
  return (vault ??= new VaultStore(getAreas()));
}

export function getPrefs(): PreferencesStore {
  return (prefs ??= new PreferencesStore(getAreas().local));
}

export function getFxaClient(): FxAClient {
  return (fxa ??= new FxAClient({ userAgent: USER_AGENT }));
}

export function getSyncEngine(): SyncEngine {
  return (engine ??= new SyncEngine({
    vault: getVault(),
    client: getFxaClient(),
    userAgent: USER_AGENT,
  }));
}

export function getUpdateChecker(): UpdateChecker {
  return (updates ??= new UpdateChecker({
    area: getAreas().local,
    currentVersion: chrome.runtime.getManifest().version,
    settings: async () => (await getPrefs().global()).updates,
  }));
}

/** Drop cached objects — used after a reset so nothing stale survives. */
export function resetState(): void {
  areas = null;
  vault = null;
  prefs = null;
  fxa = null;
  engine = null;
  updates = null;
}

/** Tell every content script and open page that the lock state changed. */
export async function broadcast(message: unknown): Promise<void> {
  await chrome.runtime.sendMessage(message).catch(() => undefined);
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.all(
    tabs.map((tab) =>
      tab.id !== undefined
        ? chrome.tabs.sendMessage(tab.id, message).catch(() => undefined)
        : undefined,
    ),
  );
}
