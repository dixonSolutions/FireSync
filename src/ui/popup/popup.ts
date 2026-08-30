/** The toolbar popup: status, credential list, manual sync. */

import { sendMessage } from '../../common/messages.ts';
import type { CredentialSummary, VaultStatus } from '../../common/messages.ts';
import { waitForSignIn } from '../wait-for-signin.ts';

const statusEl = document.getElementById('status') as HTMLDivElement;
const listEl = document.getElementById('list') as HTMLUListElement;
const errorEl = document.getElementById('error') as HTMLDivElement;
const filterEl = document.getElementById('filter') as HTMLInputElement;

let credentials: CredentialSummary[] = [];

function showError(error: unknown): void {
  errorEl.textContent = error instanceof Error ? error.message : String(error);
}

function setHidden(id: string, hidden: boolean): void {
  const element = document.getElementById(id);
  if (element) element.hidden = hidden;
}

function relative(timestamp: number | null): string {
  if (!timestamp) return 'never synced';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'synced just now';
  if (seconds < 3600) return `synced ${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `synced ${Math.round(seconds / 3600)} h ago`;
  return `synced ${Math.round(seconds / 86400)} d ago`;
}

function renderStatus(status: VaultStatus): boolean {
  // Not signed in is the only state that needs setting up, and the only thing
  // to ask for. There is no passphrase and, by default, nothing to unlock.
  if (!status.connected) {
    statusEl.textContent = 'Not signed in';
    showSignInPrompt();
    // Nothing to lock and nothing to sync: offering either would be a button
    // that cannot do anything.
    setHidden('lock', true);
    setHidden('sync', true);
    return false;
  }
  // Lock only exists in passphrase mode. In device mode there is nothing to
  // withhold, and the button would strand the user on an unlock screen that
  // has no passphrase to accept.
  setHidden('lock', status.protection !== 'passphrase');
  setHidden('sync', false);
  if (!status.unlocked) {
    statusEl.textContent = 'Locked';
    location.href = 'unlock.html';
    return false;
  }
  const counts = status.counts;
  statusEl.textContent = `${status.email}\n${counts?.passwords ?? 0} logins · ${relative(
    status.lastSyncAt,
  )}`;
  if (status.lastSyncError) showError(status.lastSyncError);
  return true;
}

/** Replace the credential list with a single call to action. */
function showSignInPrompt(): void {
  filterEl.hidden = true;
  listEl.replaceChildren();

  const wrap = document.createElement('div');
  wrap.style.cssText = 'text-align:center;padding:18px 6px 8px';

  const line = document.createElement('p');
  line.className = 'status';
  line.style.margin = '0 0 12px';
  line.textContent = 'Sign in with the Mozilla account you sync Firefox with.';

  const button = document.createElement('button');
  button.className = 'primary';
  button.style.width = '100%';
  button.textContent = 'Sign in at accounts.firefox.com';
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Opening Mozilla sign-in…';
    try {
      await sendMessage({ type: 'account/signInHosted' });
      // The popup closes the moment the sign-in tab takes focus, so this often
      // never resolves here — and that is fine. The background finishes on its
      // own now; reopening the popup shows the result.
      button.textContent = 'Finish signing in, then reopen this popup';
      const result = await waitForSignIn();
      if (result.status === 'complete') await load();
      else if (result.error) showError(result.error);
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in at accounts.firefox.com';
    }
  });

  wrap.append(line, button);
  listEl.append(wrap);
}

function renderList(): void {
  const needle = filterEl.value.trim().toLowerCase();
  const visible = needle
    ? credentials.filter(
        (credential) =>
          credential.username.toLowerCase().includes(needle) ||
          credential.origin.toLowerCase().includes(needle),
      )
    : credentials;

  listEl.replaceChildren();
  for (const credential of visible.slice(0, 200)) {
    const item = document.createElement('li');

    const text = document.createElement('div');
    text.className = 'grow';
    const user = document.createElement('div');
    user.className = 'user';
    user.textContent = credential.username || '(no username)';
    const origin = document.createElement('div');
    origin.className = 'origin';
    origin.textContent = credential.origin;
    text.append(user, origin);

    const copy = document.createElement('button');
    copy.className = 'ghost';
    copy.textContent = 'Copy';
    copy.title = 'Copy password to the clipboard';
    copy.addEventListener('click', async () => {
      try {
        const record = await sendMessage({ type: 'passwords/get', id: credential.id });
        if (!record) return;
        await navigator.clipboard.writeText(record.password);
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1200);
      } catch (error) {
        showError(error);
      }
    });

    item.append(text, copy);
    listEl.append(item);
  }
}

/**
 * The version line, and whether Chrome is the one keeping it current.
 *
 * "Managed by Chrome" is not a guess: it is true exactly when the running
 * manifest carries an `update_url`, which is the case for a policy install and
 * not for a load-unpacked one. The distinction matters, so the popup states
 * which of the two you have rather than implying updates just happen.
 */
async function renderVersion(): Promise<void> {
  const line = document.getElementById('version-line') as HTMLElement;
  const managed = document.getElementById('update-managed') as HTMLElement;
  try {
    const report = await sendMessage({ type: 'updates/status' });
    line.textContent = `FireSync ${report.currentVersion}`;

    if (report.state.available) {
      managed.textContent = `${report.state.available.version} available`;
    } else if (report.managedByBrowser) {
      managed.textContent = 'auto-updating';
      managed.title = 'Installed with an update URL — the browser checks for new versions.';
    } else {
      managed.textContent = 'manual updates';
      managed.title =
        'Installed without an update URL (load-unpacked), so the browser will not update it.';
    }
  } catch {
    line.textContent = 'FireSync';
  }
}

/**
 * A self-hosted build cannot update itself, so the popup is where the user finds
 * out that a new one exists. Shown only when there is genuinely something to do.
 */
async function renderUpdateBanner(): Promise<void> {
  const banner = document.getElementById('update-banner') as HTMLDivElement;
  try {
    const report = await sendMessage({ type: 'updates/status' });
    if (!report.notify || !report.state.available) {
      banner.hidden = true;
      return;
    }

    const available = report.state.available;
    const link = document.getElementById('update-banner-link') as HTMLAnchorElement;
    const href = available.crx ?? available.zip ?? available.releaseUrl;
    const text = document.getElementById('update-banner-text') as HTMLElement;

    if (report.managedByBrowser) {
      // The browser will fetch it on its own; a download link would just be a
      // slower way to arrive at the same place.
      text.textContent = `${available.version} available — installs on restart`;
      link.hidden = true;
    } else {
      text.textContent = `FireSync ${available.version} is available`;
      link.hidden = !href;
      if (href) link.href = href;
    }

    document.getElementById('update-banner-dismiss')?.addEventListener('click', async () => {
      await sendMessage({ type: 'updates/dismiss', version: available.version });
      banner.hidden = true;
    });

    banner.hidden = false;
  } catch {
    banner.hidden = true;
  }
}

async function load(): Promise<void> {
  try {
    const status = await sendMessage({ type: 'vault/status' });
    const ready = renderStatus(status);
    if (ready) {
      filterEl.hidden = false;
      credentials = await sendMessage({ type: 'passwords/list' });
      credentials.sort((a, b) => a.origin.localeCompare(b.origin));
      renderList();
    }
  } catch (error) {
    showError(error);
  }
}

filterEl.addEventListener('input', renderList);

document.getElementById('lock')?.addEventListener('click', async () => {
  await sendMessage({ type: 'vault/lock' });
  location.href = 'unlock.html';
});

document.getElementById('sync')?.addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  button.textContent = 'Syncing…';
  try {
    const result = await sendMessage({ type: 'sync/now' });
    if (!result.ok) showError(result.error ?? 'sync failed');
    await load();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = 'Sync now';
  }
});

document.getElementById('options')?.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

document.getElementById('check-updates')?.addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const report = await sendMessage({ type: 'updates/check' });
    await renderVersion();
    await renderUpdateBanner();

    if (report.state.available) {
      button.textContent = `${report.state.available.version} available`;
    } else if (report.state.lastError) {
      showError(report.state.lastError);
      button.textContent = original;
    } else {
      button.textContent = 'Up to date';
      setTimeout(() => (button.textContent = original), 2000);
    }
  } catch (error) {
    showError(error);
    button.textContent = original;
  } finally {
    button.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message?.type === 'state/signedin') void load();
});

void load();
void renderVersion();
void renderUpdateBanner();
