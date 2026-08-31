/**
 * Service worker entry point.
 *
 * Everything is registered synchronously at the top level: Chrome dispatches
 * events to a freshly-woken worker immediately, and a listener added inside an
 * `await` would miss the very event that woke it.
 */

import {
  ALARM,
  installRouter,
  scheduleAutoLock,
  schedulePeriodicSync,
  scheduleUpdateCheck,
} from './router.ts';
import { broadcast, getAreas, getPrefs, getSignIn, getSyncEngine, getUpdateChecker, getVault } from './state.ts';

installRouter();

/**
 * Sign-in navigation listeners, registered at the top level so they exist on
 * every service-worker wake. A navigation wakes the worker, which re-runs this
 * file, which re-registers these — which is the only way a flow spanning a
 * several-minute Mozilla sign-in can survive an MV3 worker's ~30 second life.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void getSignIn().onNavigation(tabId, changeInfo.url ?? tab.url);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void getSignIn().onTabClosed(tabId);
});

// A third path. `tabs.onUpdated` does not always carry a URL, and a worker that
// is asleep may be woken by one event and not another; webNavigation reports
// commits directly and costs nothing when no sign-in is pending.
chrome.webNavigation?.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  void getSignIn().onNavigation(details.tabId, details.url);
});
chrome.webNavigation?.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  void getSignIn().onNavigation(details.tabId, details.url);
});

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await schedulePeriodicSync();
    await scheduleAutoLock();
    await scheduleUpdateCheck();
    // An update just landed, so whatever we knew about it is stale.
    if (details.reason === 'update') await getUpdateChecker().reset();
    await refreshBadge();
    if (details.reason === 'install') {
      await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    // `chrome.storage.session` is already empty after a browser restart, so the
    // vault is locked by construction. This only re-arms the schedules.
    await schedulePeriodicSync();
    await scheduleUpdateCheck();
    await getUpdateChecker().check().catch(() => undefined);
    await syncIfNeverSynced();
    await refreshBadge();
  })();
});

/** Marks that this browser session has already tried the catch-up sync. */
const STARTUP_SYNC_TRIED = 'firesync.startup.syncTried';

/**
 * Sync once per browser session for an account that has never synced at all.
 *
 * Connecting an account triggers the first sync, but an account connected
 * before that was true — or one whose first sync was interrupted — sits at
 * "0 logins, never synced" indefinitely, showing whatever error was recorded
 * last, which for a freshly connected account is an error about not having one.
 * Nothing in the normal run of things gets such a profile unstuck.
 *
 * Called from the module body rather than `chrome.runtime.onStartup`, which is
 * not dispatched to an extension loaded with `--load-extension`: that extension
 * is installed *as part of* startup, so the event it is waiting for has already
 * been sent. The module body runs on every worker wake instead, and the guard
 * below lives in `chrome.storage.session`, which dies with the browser — so
 * this runs at most once per session however often the worker is recycled.
 *
 * Guarded on `lastSyncAt` being null rather than on the error, so it stops
 * firing after one sync succeeds and never becomes a retry loop for an account
 * that syncs and then starts failing.
 */
async function syncIfNeverSynced(): Promise<void> {
  try {
    const session = getAreas().session;
    if (await session.get(STARTUP_SYNC_TRIED)) return;

    const vault = getVault();
    if (!(await vault.isUnlocked())) return;
    if (!(await vault.readTokens())) return;
    if ((await vault.readSyncState()).lastSyncAt !== null) return;

    await session.set(STARTUP_SYNC_TRIED, true);
    const result = await getSyncEngine().sync();
    await broadcast({ type: 'state/synced', result });
    await refreshBadge();
  } catch {
    // Recorded in sync state by the engine; the popup reads it from there.
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    if (alarm.name === ALARM.sync) {
      const vault = getVault();
      if (!(await vault.isUnlocked())) return;
      const result = await getSyncEngine().sync();
      await broadcast({ type: 'state/synced', result });
      await refreshBadge();
    }
    if (alarm.name === ALARM.updateCheck) {
      await getUpdateChecker().check().catch(() => undefined);
      // Chrome only acts on this for builds it manages; harmless otherwise.
      await chrome.runtime.requestUpdateCheck?.().catch(() => undefined);
      await refreshBadge();
    }
    if (alarm.name === ALARM.autoLock) {
      await getVault().lock();
      await broadcast({ type: 'state/locked' });
      await refreshBadge();
    }
  })();
});

/** Re-arm the auto-lock countdown whenever the user comes back. */
chrome.idle.onStateChanged.addListener((state) => {
  void (async () => {
    if (state === 'locked') {
      await getVault().lock();
      await broadcast({ type: 'state/locked' });
      await refreshBadge();
      return;
    }
    if (state === 'active') await scheduleAutoLock();
  })();
});

/**
 * A long-lived port from the onboarding page keeps this worker alive for the
 * duration of a sign-in, so an in-flight `ConnectSession` (which holds a
 * session token in memory only) survives the TOTP prompt.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'firesync.keepalive') return;
  const interval = setInterval(() => port.postMessage({ type: 'ping' }), 20_000);
  port.onDisconnect.addListener(() => clearInterval(interval));
});

async function refreshBadge(): Promise<void> {
  const vault = getVault();
  const initialized = await vault.isInitialized();
  const unlocked = initialized && (await vault.isUnlocked());

  // An available update outranks everything else on the badge: it is the one
  // thing the user must act on, because a self-hosted build cannot act itself.
  if (await getUpdateChecker().shouldNotify().catch(() => false)) {
    const state = await getUpdateChecker().state();
    await chrome.action.setBadgeText({ text: '↑' });
    await chrome.action.setBadgeBackgroundColor({ color: '#FF3D7F' });
    await chrome.action.setTitle({
      title: `FireSync ${state.available?.version} is available`,
    });
    return;
  }

  if (!initialized) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#FF6B35' });
    await chrome.action.setTitle({ title: 'FireSync — set up' });
    return;
  }
  if (!unlocked) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'FireSync — locked' });
    return;
  }
  const stats = await vault.stats().catch(() => null);
  await chrome.action.setBadgeText({ text: stats?.pendingUploads ? String(stats.pendingUploads) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#9B5DE5' });
  await chrome.action.setTitle({
    title: stats ? `FireSync — ${stats.passwords} logins` : 'FireSync',
  });
}

// Keep the badge honest after any storage-visible change.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local' || area === 'session') void refreshBadge();
});

void (async () => {
  await getPrefs().global();
  await refreshBadge();
  await syncIfNeverSynced();
})();
