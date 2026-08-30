import { sendMessage } from '../../common/messages.ts';
import type { GlobalPreferences } from '../../prefs/types.ts';

const errorEl = document.getElementById('error') as HTMLDivElement;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function showError(error: unknown): void {
  errorEl.textContent = error instanceof Error ? error.message : String(error);
}

async function patch(update: Partial<GlobalPreferences>): Promise<void> {
  try {
    await sendMessage({ type: 'prefs/setGlobal', patch: update });
    errorEl.textContent = '';
  } catch (error) {
    showError(error);
  }
}

function bindSelect(id: string, apply: (value: string) => Partial<GlobalPreferences>): void {
  el<HTMLSelectElement>(id).addEventListener('change', (event) => {
    void patch(apply((event.target as HTMLSelectElement).value));
  });
}

function bindCheckbox(id: string, apply: (value: boolean) => Partial<GlobalPreferences>): void {
  el<HTMLInputElement>(id).addEventListener('change', (event) => {
    void patch(apply((event.target as HTMLInputElement).checked));
  });
}

function bindNumber(id: string, apply: (value: number) => Partial<GlobalPreferences>): void {
  el<HTMLInputElement>(id).addEventListener('change', (event) => {
    void patch(apply(Number((event.target as HTMLInputElement).value)));
  });
}

async function render(): Promise<void> {
  const prefs = await sendMessage({ type: 'prefs/global' });
  el<HTMLSelectElement>('inlineMenu').value = prefs.inlineMenu;
  el<HTMLSelectElement>('defaultMatchStrategy').value = prefs.defaultMatchStrategy;
  el<HTMLInputElement>('autoFillOnLoad').checked = prefs.autoFillOnLoad;
  el<HTMLInputElement>('savePrompt').checked = prefs.savePrompt;
  el<HTMLInputElement>('lockTimeoutMinutes').value = String(prefs.lockTimeoutMinutes);
  el<HTMLInputElement>('lockOnBrowserClose').checked = prefs.lockOnBrowserClose;
  el<HTMLInputElement>('syncIntervalMinutes').value = String(prefs.syncIntervalMinutes);
  el<HTMLInputElement>('engine-passwords').checked = prefs.engines.passwords;
  el<HTMLInputElement>('engine-addresses').checked = prefs.engines.addresses;
  el<HTMLInputElement>('engine-creditcards').checked = prefs.engines.creditcards;
  el<HTMLInputElement>('syncSitePreferences').checked = prefs.syncSitePreferences;

  const status = await sendMessage({ type: 'vault/status' });
  el('account-email').textContent = status.email ?? 'Not connected';
  el('account-detail').textContent = status.connected
    ? `${status.counts?.passwords ?? 0} logins, ${status.counts?.pendingUploads ?? 0} pending upload`
    : 'Connect from the FireSync setup page.';
}

bindSelect('inlineMenu', (value) => ({ inlineMenu: value as GlobalPreferences['inlineMenu'] }));
bindSelect('defaultMatchStrategy', (value) => ({
  defaultMatchStrategy: value as GlobalPreferences['defaultMatchStrategy'],
}));
bindCheckbox('autoFillOnLoad', (value) => ({ autoFillOnLoad: value }));
bindCheckbox('savePrompt', (value) => ({ savePrompt: value }));
bindCheckbox('lockOnBrowserClose', (value) => ({ lockOnBrowserClose: value }));
bindCheckbox('syncSitePreferences', (value) => ({ syncSitePreferences: value }));
bindNumber('lockTimeoutMinutes', (value) => ({ lockTimeoutMinutes: value }));
bindNumber('syncIntervalMinutes', (value) => ({ syncIntervalMinutes: value }));

for (const engine of ['passwords', 'addresses', 'creditcards'] as const) {
  el<HTMLInputElement>(`engine-${engine}`).addEventListener('change', async (event) => {
    const current = await sendMessage({ type: 'prefs/global' });
    await patch({
      engines: { ...current.engines, [engine]: (event.target as HTMLInputElement).checked },
    });
  });
}

el('changePassphrase').addEventListener('click', async () => {
  const current = prompt('Current FireSync passphrase');
  if (!current) return;
  const next = prompt('New passphrase (at least 10 characters)');
  if (!next || next.length < 10) {
    showError('Passphrase must be at least 10 characters.');
    return;
  }
  try {
    await sendMessage({ type: 'vault/changePassphrase', current, next });
    errorEl.textContent = 'Passphrase changed.';
  } catch (error) {
    showError(error);
  }
});

el('disconnect').addEventListener('click', async () => {
  if (!confirm('Disconnect the Mozilla account? Local logins stay in the vault.')) return;
  try {
    await sendMessage({ type: 'account/disconnect' });
    await render();
  } catch (error) {
    showError(error);
  }
});

// ------------------------------------------------------------------ updates

async function renderUpdates(): Promise<void> {
  const prefs = await sendMessage({ type: 'prefs/global' });
  el<HTMLSelectElement>('update-mode').value = prefs.updates.mode;
  el<HTMLInputElement>('update-interval').value = String(prefs.updates.intervalHours);
  el<HTMLInputElement>('update-url').value = prefs.updates.manifestUrl;

  const report = await sendMessage({ type: 'updates/status' });
  const state = el('update-state');
  const detail = el('update-detail');

  const checked = report.state.lastCheckedAt
    ? `last checked ${new Date(report.state.lastCheckedAt).toLocaleString()}`
    : 'never checked';

  if (report.state.available) {
    const available = report.state.available;
    state.textContent = `Version ${available.version} is available — you have ${report.currentVersion}`;

    detail.replaceChildren();
    if (available.notes) detail.append(document.createTextNode(`${available.notes} · `));

    if (report.managedByBrowser) {
      detail.append(
        document.createTextNode('Chrome manages this install and will update it for you.'),
      );
    } else {
      for (const [label, href] of [
        ['Download CRX', available.crx],
        ['Download ZIP', available.zip],
        ['Release notes', available.releaseUrl],
      ] as const) {
        if (!href) continue;
        const link = document.createElement('a');
        link.href = href;
        link.textContent = label;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.style.marginRight = '10px';
        detail.append(link);
      }
    }

    const dismiss = document.createElement('button');
    dismiss.className = 'ghost';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', async () => {
      await sendMessage({ type: 'updates/dismiss', version: available.version });
      await renderUpdates();
    });
    detail.append(dismiss);
    return;
  }

  state.textContent = `FireSync ${report.currentVersion} — up to date`;
  detail.textContent = report.state.lastError
    ? `Last check failed: ${report.state.lastError}`
    : checked;
}

el('update-check').addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    await sendMessage({ type: 'updates/check' });
    await renderUpdates();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = 'Check now';
  }
});

el<HTMLSelectElement>('update-mode').addEventListener('change', async (event) => {
  const current = await sendMessage({ type: 'prefs/global' });
  await patch({
    updates: {
      ...current.updates,
      mode: (event.target as HTMLSelectElement).value as typeof current.updates.mode,
    },
  });
  await renderUpdates();
});

for (const [id, key] of [
  ['update-interval', 'intervalHours'],
  ['update-url', 'manifestUrl'],
] as const) {
  el<HTMLInputElement>(id).addEventListener('change', async (event) => {
    const current = await sendMessage({ type: 'prefs/global' });
    const raw = (event.target as HTMLInputElement).value;
    await patch({
      updates: {
        ...current.updates,
        [key]: key === 'intervalHours' ? Number(raw) : raw.trim(),
      },
    });
    await renderUpdates();
  });
}

// ------------------------------------------------------------- local bridge

/**
 * The bridge is optional and its `nativeMessaging` permission is not granted at
 * install time, so this is the one place that asks for it — from a click, which
 * `chrome.permissions.request` requires.
 */
async function renderBridge(): Promise<void> {
  const state = el('bridge-state');
  const detail = el('bridge-detail');
  const table = el<HTMLTableElement>('bridge-profiles');
  const rows = el('bridge-profile-rows');
  const enable = el<HTMLButtonElement>('bridge-enable');

  const granted = await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
  if (!granted) {
    state.textContent = 'Bridge not enabled';
    detail.textContent = 'FireSync has not been given permission to talk to a local helper.';
    table.hidden = true;
    enable.hidden = false;
    return;
  }
  enable.hidden = true;

  const status = await sendMessage({ type: 'bridge/status' });
  if (!status.available) {
    state.textContent = 'Bridge not detected';
    detail.textContent = status.reason ?? 'The helper did not respond.';
    table.hidden = true;
    return;
  }

  state.textContent = `Bridge ${status.info?.version ?? ''} on ${status.info?.platform ?? ''}`;
  detail.textContent = `Capabilities: ${status.info?.capabilities.join(', ') ?? 'none'}`;

  rows.replaceChildren();
  table.hidden = status.profiles.length === 0;
  if (!status.profiles.length) {
    detail.textContent += ' — no Firefox profiles found on this machine.';
    return;
  }

  for (const profile of status.profiles) {
    const row = document.createElement('tr');

    const name = document.createElement('td');
    name.textContent = profile.name;
    const count = document.createElement('td');
    count.textContent = String(profile.loginCount);

    const action = document.createElement('td');
    const button = document.createElement('button');
    button.textContent = 'Import';
    button.addEventListener('click', () => void importProfile(profile.path, button));
    action.append(button);

    row.append(name, count, action);
    rows.append(row);
  }
}

async function importProfile(path: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = 'Importing…';
  try {
    let summary;
    try {
      summary = await sendMessage({ type: 'bridge/import', path });
    } catch (error) {
      // The only expected failure is a primary password, so ask for it once
      // rather than making the user find a separate setting.
      if (!/primary password/i.test(String(error))) throw error;
      const primaryPassword = prompt('This Firefox profile has a primary password:');
      if (!primaryPassword) return;
      summary = await sendMessage({ type: 'bridge/import', path, primaryPassword });
    }
    errorEl.textContent =
      `Imported ${summary.imported} login(s); ${summary.duplicates} already present` +
      (summary.skipped ? `, ${summary.skipped} unreadable` : '') + '.';
    await render();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = 'Import';
  }
}

el('bridge-enable').addEventListener('click', async () => {
  const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
  if (!granted) {
    showError('Permission declined — the bridge stays disabled.');
    return;
  }
  await renderBridge();
});

void render().catch(showError);
void renderUpdates().catch(showError);
void renderBridge().catch(showError);
