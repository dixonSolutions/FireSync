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

function renderStatus(status: VaultStatus): void {
  if (!status.initialized) {
    statusEl.textContent = 'Not set up yet';
    void chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    return;
  }
  if (!status.unlocked) {
    statusEl.textContent = 'Locked';
    location.href = 'unlock.html';
    return;
  }
  if (!status.connected) {
    statusEl.textContent = 'No Mozilla account connected';
    return;
  }
  const counts = status.counts;
  statusEl.textContent = `${status.email} · ${counts?.passwords ?? 0} logins · ${relative(
    status.lastSyncAt,
  )}`;
  if (status.lastSyncError) showError(status.lastSyncError);
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

async function load(): Promise<void> {
  try {
    const status = await sendMessage({ type: 'vault/status' });
    renderStatus(status);
    if (status.unlocked) {
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
