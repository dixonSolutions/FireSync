/**
 * The message router: the single entry point from every content script and
 * extension page into the privileged half of FireSync.
 *
 * Two invariants:
 *   - a handler never returns a password unless the message asked for exactly
 *     one credential by id, and the page URL still matches that credential;
 *   - every failure comes back as `{ok: false, error}` rather than a rejected
 *     promise, so a content script can never hang waiting on a dead worker.
 */

import { fail, ok } from '../common/messages.ts';
import { UpdateChecker } from '../update/checker.ts';
import type { CredentialSummary, Message, Reply, ResponseMap, VaultStatus } from '../common/messages.ts';
import { BridgeClient } from '../bridge/client.ts';
import { BridgeUnavailableError } from '../bridge/protocol.ts';
import { ConnectSession } from '../fxa/connect.ts';
import type { ConnectStep } from '../fxa/connect.ts';
import { originMatches } from '../match/uri.ts';
import { newPasswordRecord } from '../sync15/engines/passwords.ts';
import { passwordAuthorityTime } from '../sync15/engines/passwords.ts';
import { VaultLockedError } from '../vault/crypto.ts';
import {
  broadcast,
  getFxaClient,
  getPrefs,
  getSignIn,
  getSyncEngine,
  getUpdateChecker,
  getVault,
  USER_AGENT,
} from './state.ts';

/**
 * The in-flight sign-in, if any. Held in memory only: it contains a session
 * token, and a session token is full account control. The onboarding page keeps
 * a `chrome.runtime` port open so the worker stays alive for the duration.
 */
let connectSession: ConnectSession | null = null;

async function vaultStatus(): Promise<VaultStatus> {
  const vault = getVault();
  const initialized = await vault.isInitialized();
  const unlocked = initialized && (await vault.isUnlocked());

  const protection = await vault.protection();

  if (!unlocked) {
    return {
      initialized,
      unlocked,
      protection,
      connected: false,
      email: null,
      counts: null,
      lastSyncAt: null,
      lastSyncError: null,
    };
  }

  const [tokens, counts, syncState] = await Promise.all([
    vault.readTokens(),
    vault.stats(),
    vault.readSyncState(),
  ]);
  return {
    initialized,
    unlocked,
    protection,
    connected: tokens !== null,
    email: tokens?.email ?? null,
    counts,
    lastSyncAt: syncState.lastSyncAt,
    lastSyncError: syncState.lastSyncError,
  };
}

function summarize(record: {
  id: string;
  username: string;
  hostname: string;
}): CredentialSummary {
  return { id: record.id, username: record.username, origin: record.hostname };
}

async function handle(message: Message, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const vault = getVault();
  const prefs = getPrefs();

  switch (message.type) {
    // -------------------------------------------------------------- vault
    case 'vault/status':
      return vaultStatus();

    case 'vault/unlock':
      await vault.unlock(message.passphrase);
      await scheduleAutoLock();
      await broadcast({ type: 'state/unlocked' });
      return vaultStatus();

    case 'vault/lock':
      await vault.lock();
      await broadcast({ type: 'state/locked' });
      return vaultStatus();

    case 'vault/setPassphrase':
      await vault.setProtection({ passphrase: message.passphrase }, message.current);
      await scheduleAutoLock();
      await broadcast({ type: 'state/unlocked' });
      return vaultStatus();

    case 'vault/reset':
      await vault.reset();
      await broadcast({ type: 'state/locked' });
      return vaultStatus();

    // ------------------------------------------------------------ account
    case 'account/signInHosted':
      await vault.ensure();
      return getSignIn().begin(message.email);

    case 'account/signInProgress':
      return getSignIn().progress();

    case 'account/diagnostics':
      return getSignIn().diagnostics();

    // The relay content script running on the OAuth success page. Its own URL
    // is authoritative; a page cannot claim to be somewhere it is not.
    case 'signin/redirect':
      await getSignIn().onNavigation(sender.tab?.id ?? -1, sender.url ?? message.url);
      return null;

    case 'account/cancelSignIn':
      await getSignIn().cancel();
      return getSignIn().progress();

    case 'account/connect': {
      await vault.ensure();
      connectSession = new ConnectSession({
        client: getFxaClient(),
        deviceName: `FireSync on ${navigatorLabel()}`,
      });
      const step = await connectSession.begin(
        message.email,
        message.password,
        message.unblockCode,
      );
      return finishConnect(step);
    }

    case 'account/submitTotp': {
      if (!connectSession) throw new Error('no sign-in is in progress');
      return finishConnect(await connectSession.submitTotp(message.code));
    }

    case 'account/submitEmailCode': {
      if (!connectSession) throw new Error('no sign-in is in progress');
      return finishConnect(await connectSession.submitEmailCode(message.code));
    }

    case 'account/resendEmailCode':
      if (!connectSession) throw new Error('no sign-in is in progress');
      await connectSession.resendEmailCode();
      return null;

    case 'account/disconnect': {
      const tokens = await vault.readTokens();
      if (tokens) {
        await getFxaClient()
          .destroyOAuthToken(
            tokens.refreshToken,
            tokens.clientId ? { clientId: tokens.clientId } : {},
          )
          .catch(() => undefined);
      }
      await vault.clearTokens();
      return vaultStatus();
    }

    // --------------------------------------------------------------- sync
    case 'sync/now': {
      const result = await getSyncEngine().sync();
      await broadcast({ type: 'state/synced', result });
      return result;
    }

    // ---------------------------------------------------------- passwords
    case 'passwords/list':
      return (await vault.listPasswords()).map(summarize);

    case 'passwords/get':
      return vault.getPassword(message.id);

    case 'passwords/delete':
      await vault.deletePassword(message.id);
      return null;

    case 'passwords/update':
      return vault.patchPassword(message.id, message.patch);

    // ----------------------------------------------------------- autofill
    case 'autofill/query': {
      const pageUrl = senderUrl(sender, message.pageUrl);
      const [mode, autoFill, unlocked] = await Promise.all([
        prefs.inlineMenuMode(pageUrl),
        prefs.autoFillEnabled(pageUrl),
        vault.isUnlocked(),
      ]);
      if (!unlocked) {
        return { matches: [], unlocked, inlineMenu: mode, autoFill: false };
      }
      const strategy = await prefs.matchStrategy(pageUrl);
      const site = await prefs.forUrl(pageUrl);
      const matches = await vault.findPasswordsForUrl(pageUrl, {
        strategy,
        ...(site?.equivalentDomains ? { extraEquivalentDomains: site.equivalentDomains } : {}),
      });
      return {
        matches: matches.map((match) => summarize(match.record)),
        unlocked,
        inlineMenu: mode,
        autoFill,
      };
    }

    case 'autofill/reveal': {
      const pageUrl = senderUrl(sender, message.pageUrl);
      const record = await vault.getPassword(message.id);
      if (!record) return null;
      // Re-check the match at reveal time: the tab may have navigated between
      // the menu opening and the user clicking.
      const strategy = await prefs.matchStrategy(pageUrl);
      if (!originMatches(record.hostname, pageUrl, { strategy })) return null;
      await vault.touchPassword(record.id);
      void queueSync();
      return { ...summarize(record), password: record.password };
    }

    case 'autofill/captured': {
      const pageUrl = senderUrl(sender, message.credential.pageUrl);
      if (!(await prefs.savePromptEnabled(pageUrl))) return { shouldPrompt: false };
      if (!(await vault.isUnlocked())) return { shouldPrompt: false };
      // An unlocked vault is not a connected account, and in device mode it is
      // barely a signal at all: `isUnlocked()` returns true for the whole life
      // of the vault, and `account/signInHosted` calls `vault.ensure()` before
      // it sends the user to Mozilla. So merely *starting* a sign-in — even one
      // that then fails — used to leave the user being asked to save logins
      // into a vault with nowhere to sync them.
      if (!(await vault.readTokens())) return { shouldPrompt: false };

      const existing = await vault.findPasswordsForUrl(pageUrl, {
        strategy: await prefs.matchStrategy(pageUrl),
      });
      const sameUser = existing.find(
        (match) => match.record.username === message.credential.username,
      );
      if (!sameUser) return { shouldPrompt: true };
      if (sameUser.record.password === message.credential.password) {
        return { shouldPrompt: false };
      }
      return { shouldPrompt: true, existingCredentialId: sameUser.record.id };
    }

    case 'autofill/save': {
      const credential = message.credential;
      const record = await vault.addPassword({
        origin: credential.origin,
        username: credential.username,
        password: credential.password,
        formActionOrigin: credential.formActionOrigin,
        usernameField: credential.usernameField,
        passwordField: credential.passwordField,
      });
      void queueSync();
      return { id: record.id };
    }

    case 'autofill/updateExisting': {
      const record = await vault.updatePassword(message.id, message.password);
      void queueSync();
      return { id: record.id };
    }

    // -------------------------------------------------------------- prefs
    case 'prefs/global':
      return prefs.global();

    case 'prefs/setGlobal': {
      const next = await prefs.setGlobal(message.patch);
      await scheduleAutoLock();
      await schedulePeriodicSync();
      await scheduleUpdateCheck();
      return next;
    }

    case 'prefs/forUrl':
      return prefs.forUrl(senderUrl(sender, message.pageUrl));

    case 'prefs/setForUrl':
      return prefs.setForUrl(senderUrl(sender, message.pageUrl), message.patch);

    case 'prefs/neverSave':
      return prefs.setForUrl(senderUrl(sender, message.pageUrl), { neverSave: true });

    // ------------------------------------------------------------ updates
    case 'updates/status':
      return updateReport();

    case 'updates/check':
      await getUpdateChecker().check(true);
      // Policy-installed builds really can update; ask Chrome to try too.
      await chrome.runtime.requestUpdateCheck?.().catch(() => undefined);
      return updateReport();

    case 'updates/dismiss':
      await getUpdateChecker().dismiss(message.version);
      return updateReport();

    // ------------------------------------------------------------- bridge
    case 'bridge/status':
      return bridgeStatus();

    case 'bridge/import':
      return importFromFirefox(message.path, message.primaryPassword);

    case 'menu/resize':
    case 'menu/close':
      return null;

    default: {
      const exhaustive: never = message;
      throw new Error(`unknown message: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Persist the account when the sign-in machine reports completion. */
async function finishConnect(step: ConnectStep): Promise<{ step: string; email?: string }> {
  if (step.kind !== 'complete') {
    return 'email' in step ? { step: step.kind, email: step.email } : { step: step.kind };
  }
  const vault = getVault();
  await vault.writeTokens(step.account);
  connectSession = null;
  void queueSync();
  return { step: 'complete', email: step.account.email };
}

/**
 * The sender's own URL is authoritative; a content script may not claim to be
 * on a page it is not on. Extension pages have no tab URL, so they may pass one.
 */
function senderUrl(sender: chrome.runtime.MessageSender, claimed: string): string {
  if (sender.tab && sender.url) return sender.url;
  if (sender.url && sender.url.startsWith('chrome-extension://')) return claimed;
  return sender.url ?? claimed;
}

function navigatorLabel(): string {
  const agent = typeof navigator !== 'undefined' ? navigator.userAgent : USER_AGENT;
  if (/Windows/.test(agent)) return 'Windows';
  if (/Macintosh/.test(agent)) return 'macOS';
  if (/CrOS/.test(agent)) return 'ChromeOS';
  if (/Linux/.test(agent)) return 'Linux';
  return 'Chrome';
}

/**
 * Assemble the update panel's data.
 *
 * `managedByBrowser` is how the UI knows whether to say "download it" or "Chrome
 * will handle this": a policy-installed build genuinely auto-updates, an
 * unpacked one never can.
 */
async function updateReport() {
  const checker = getUpdateChecker();
  const [state, notify] = await Promise.all([checker.state(), checker.shouldNotify()]);
  return {
    currentVersion: chrome.runtime.getManifest().version,
    state,
    notify,
    managedByBrowser: typeof chrome.runtime.getManifest().update_url === 'string',
  };
}

/**
 * Ask the optional native bridge what it can do. Never throws: an absent bridge
 * is the normal case and must read as a plain "not installed", not an error.
 */
async function bridgeStatus() {
  const client = new BridgeClient();
  try {
    const info = await client.info();
    const profiles = await client.listProfiles();
    return { available: true, info, profiles, reason: null };
  } catch (error) {
    return {
      available: false,
      info: null,
      profiles: [],
      reason:
        error instanceof BridgeUnavailableError
          ? 'The FireSync bridge is not installed on this machine.'
          : error instanceof Error
            ? error.message
            : String(error),
    };
  } finally {
    client.disconnect();
  }
}

/**
 * Import logins straight from a local Firefox profile.
 *
 * This path touches no Mozilla server at all, which makes it the one import
 * route that does not depend on a borrowed OAuth client id.
 */
async function importFromFirefox(path: string, primaryPassword?: string) {
  const vault = getVault();
  const client = new BridgeClient();

  try {
    const { logins, skipped } = await client.importProfile(path, primaryPassword);
    const existing = await vault.listPasswords();
    const seen = new Set(existing.map((record) => `${record.hostname}\u0000${record.username}`));

    let imported = 0;
    let duplicates = 0;

    for (const login of logins) {
      if (!login.origin || !login.password) {
        duplicates += 1;
        continue;
      }
      const key = `${login.origin}\u0000${login.username}`;
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      await vault.addPassword({
        origin: login.origin,
        username: login.username,
        password: login.password,
        formActionOrigin: login.formActionOrigin,
        httpRealm: login.httpRealm,
        usernameField: login.usernameField,
        passwordField: login.passwordField,
      });
      imported += 1;
    }

    if (imported > 0) void queueSync();
    return { imported, duplicates, skipped };
  } finally {
    client.disconnect();
  }
}

/** Debounced background sync after a local write. */
let syncTimer: number | undefined;
function queueSync(): void {
  if (syncTimer !== undefined) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    void getSyncEngine()
      .sync()
      .then((result) => broadcast({ type: 'state/synced', result }))
      .catch(() => undefined);
  }, 3000) as unknown as number;
}

export const ALARM = {
  sync: 'firesync.sync',
  autoLock: 'firesync.autolock',
  updateCheck: 'firesync.updatecheck',
} as const;

export async function schedulePeriodicSync(): Promise<void> {
  const { syncIntervalMinutes } = await getPrefs().global();
  await chrome.alarms.clear(ALARM.sync);
  if (syncIntervalMinutes > 0) {
    await chrome.alarms.create(ALARM.sync, { periodInMinutes: syncIntervalMinutes });
  }
}

/**
 * Re-arm the update alarm. Cleared entirely when updates are off, so a user who
 * turned them off makes no requests at all rather than merely ignoring them.
 */
export async function scheduleUpdateCheck(): Promise<void> {
  const { updates } = await getPrefs().global();
  await chrome.alarms.clear(ALARM.updateCheck);
  if (updates.mode !== 'auto') return;

  const hours = UpdateChecker.clampInterval(updates.intervalHours);
  await chrome.alarms.create(ALARM.updateCheck, {
    periodInMinutes: hours * 60,
    // Stagger the first check so a browser restart does not send every install
    // at the host in the same second.
    delayInMinutes: 3 + Math.floor(Math.random() * 10),
  });
}

export async function scheduleAutoLock(): Promise<void> {
  await chrome.alarms.clear(ALARM.autoLock);

  // Without a passphrase there is nothing to lock: the key comes from IndexedDB
  // and any click would reopen it. Scheduling a lock would be theatre.
  if ((await getVault().protection()) !== 'passphrase') return;

  const { lockTimeoutMinutes } = await getPrefs().global();
  if (lockTimeoutMinutes > 0) {
    await chrome.alarms.create(ALARM.autoLock, { delayInMinutes: lockTimeoutMinutes });
  }
}

/** Install the `chrome.runtime.onMessage` listener. */
export function installRouter(): void {
  chrome.runtime.onMessage.addListener(
    (
      message: Message,
      sender: chrome.runtime.MessageSender,
      sendResponse: (reply: Reply<unknown>) => void,
    ) => {
      handle(message, sender)
        .then((data) => sendResponse(ok(data as ResponseMap[Message['type']])))
        .catch((error: unknown) => {
          const code = error instanceof VaultLockedError ? 'locked' : undefined;
          sendResponse(fail(error, code));
        });
      return true; // keep the channel open for the async reply
    },
  );
}

export { vaultStatus, newPasswordRecord, passwordAuthorityTime };
