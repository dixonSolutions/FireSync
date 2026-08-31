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
import { SignInCoordinator } from './signin.ts';
import { UpdateChecker } from '../update/checker.ts';
import { VaultStore } from '../vault/store.ts';

export const USER_AGENT = 'FireSync/0.1 (+https://github.com/firesync/firesync)';

let areas: StorageAreas | null = null;
let vault: VaultStore | null = null;
let prefs: PreferencesStore | null = null;
let fxa: FxAClient | null = null;
let engine: SyncEngine | null = null;
let updates: UpdateChecker | null = null;
let signIn: SignInCoordinator | null = null;

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

/**
 * First sync after an account connects.
 *
 * Deliberately not routed through the router's debounced `queueSync`: that is a
 * three-second coalescing timer for local writes, and a service worker has no
 * reason to still be alive three seconds after a sign-in tab closed. This runs
 * immediately and keeps the worker awake for its duration.
 */
async function syncAfterConnect(): Promise<void> {
  try {
    const result = await getSyncEngine().sync();
    await broadcast({ type: 'state/synced', result });
  } catch {
    // The engine already records the failure in sync state; the popup reads it
    // from there. Throwing out of an event handler would only kill the worker.
  }
}

/**
 * The sign-in coordinator. Rebuilt on every service-worker wake, which is the
 * point: it keeps nothing in memory, so a fresh instance can pick up a flow
 * that a previous instance started.
 */
export function getSignIn(): SignInCoordinator {
  return (signIn ??= new SignInCoordinator({
    session: getAreas().session,
    local: getAreas().local,
    saveAccount: (account) => getVault().writeTokens(account),
    onComplete: () => {
      void broadcast({ type: 'state/signedin' });
      // Connecting an account and then syncing nothing is the one outcome the
      // onboarding page promises will not happen — it says "FireSync is syncing
      // now" the moment this fires. The password flow has always queued a sync
      // on connect; the hosted flow, which is the recommended route, never did,
      // so a successful sign-in landed on "0 logins - never synced" and stayed
      // there until an alarm happened by.
      void syncAfterConnect();
    },
    version: chrome.runtime.getManifest().version,
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
  signIn = null;
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
