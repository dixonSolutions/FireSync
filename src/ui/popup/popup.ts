/** The toolbar popup: status, credential list, manual sync. */

import { sendMessage } from '../../common/messages.ts';
import type { CredentialSummary, VaultStatus } from '../../common/messages.ts';

const statusEl = document.getElementById('status') as HTMLDivElement;
const listEl = document.getElementById('list') as HTMLUListElement;
const errorEl = document.getElementById('error') as HTMLDivElement;
const filterEl = document.getElementById('filter') as HTMLInputElement;

let credentials: CredentialSummary[] = [];

function showError(error: unknown): void {
  errorEl.textContent = error instanceof Error ? error.message : String(error);
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
    return false;
  }
  if (!status.unlocked) {
    statusEl.textContent = 'Locked';
    location.href = 'unlock.html';
    return false;
  }
  const counts = status.counts;
  statusEl.textContent = `${status.email} · ${counts?.passwords ?? 0} logins · ${relative(
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
    button.textContent = 'Waiting for Mozilla sign-in…';
    try {
      await sendMessage({ type: 'account/signInHosted' });
      await load();
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
    (document.getElementById('update-banner-text') as HTMLElement).textContent =
      `FireSync ${available.version} is available`;

    const link = document.getElementById('update-banner-link') as HTMLAnchorElement;
    const href = available.crx ?? available.zip ?? available.releaseUrl;
    if (report.managedByBrowser || !href) {
      link.hidden = true;
    } else {
      link.hidden = false;
      link.href = href;
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

void load();
void renderUpdateBanner();
