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
import { broadcast, getPrefs, getSyncEngine, getUpdateChecker, getVault } from './state.ts';

installRouter();

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
    await refreshBadge();
  })();
});

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
})();
