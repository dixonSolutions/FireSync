/**
 * OS keychain access, so the vault key can survive a browser restart without
 * the user re-typing a passphrase — on a machine they have already unlocked.
 *
 * Each platform shells out to the tool that platform already ships. Nothing is
 * bundled, and a missing tool degrades to "unsupported" rather than failing the
 * whole bridge.
 *
 *   Linux    secret-tool (libsecret) — GNOME Keyring, KWallet via the portal
 *   macOS    /usr/bin/security       — the login keychain
 *   Windows  PowerShell + DPAPI      — CurrentUser scope, stored under AppData
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const SERVICE = 'com.firesync.vault';

function has(command) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function keychainAvailable() {
  switch (platform()) {
    case 'linux':
      return has('secret-tool');
    case 'darwin':
      return existsSync('/usr/bin/security');
    case 'win32':
      return true; // DPAPI via PowerShell is always present
    default:
      return false;
  }
}

function windowsStorePath(account) {
  const base = join(
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    'FireSync',
    'secrets',
  );
  mkdirSync(base, { recursive: true });
  return join(base, `${Buffer.from(account).toString('hex')}.dpapi`);
}

function powershell(script) {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8' },
  ).trim();
}

export function keychainGet(account) {
  switch (platform()) {
    case 'linux': {
      try {
        const value = execFileSync(
          'secret-tool',
          ['lookup', 'service', SERVICE, 'account', account],
          { encoding: 'utf8' },
        );
        return value.length ? value : null;
      } catch {
        return null;
      }
    }
    case 'darwin': {
      try {
        return execFileSync(
          '/usr/bin/security',
          ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
          { encoding: 'utf8' },
        ).trim();
      } catch {
        return null;
      }
    }
    case 'win32': {
      const file = windowsStorePath(account);
      if (!existsSync(file)) return null;
      const blob = readFileSync(file, 'utf8');
      return powershell(
        `Add-Type -AssemblyName System.Security; ` +
          `[Text.Encoding]::UTF8.GetString(` +
          `[Security.Cryptography.ProtectedData]::Unprotect(` +
          `[Convert]::FromBase64String('${blob}'), $null, 'CurrentUser'))`,
      );
    }
    default:
      throw Object.assign(new Error('no keychain on this platform'), { code: 'unsupported' });
  }
}

export function keychainSet(account, secret) {
  switch (platform()) {
    case 'linux':
      execFileSync(
        'secret-tool',
        ['store', '--label=FireSync vault key', 'service', SERVICE, 'account', account],
        { input: secret },
      );
      return;
    case 'darwin':
      execFileSync('/usr/bin/security', [
        'add-generic-password',
        '-U', // update in place if it already exists
        '-s', SERVICE,
        '-a', account,
        '-w', secret,
      ]);
      return;
    case 'win32': {
      const encoded = powershell(
        `Add-Type -AssemblyName System.Security; ` +
          `[Convert]::ToBase64String(` +
          `[Security.Cryptography.ProtectedData]::Protect(` +
          `[Text.Encoding]::UTF8.GetBytes('${secret.replace(/'/g, "''")}'), $null, 'CurrentUser'))`,
      );
      writeFileSync(windowsStorePath(account), encoded, { mode: 0o600 });
      return;
    }
    default:
      throw Object.assign(new Error('no keychain on this platform'), { code: 'unsupported' });
  }
}

export function keychainDelete(account) {
  switch (platform()) {
    case 'linux':
      try {
        execFileSync('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
      } catch {
        /* already gone */
      }
      return;
    case 'darwin':
      try {
        execFileSync('/usr/bin/security', [
          'delete-generic-password',
          '-s', SERVICE,
          '-a', account,
        ]);
      } catch {
        /* already gone */
      }
      return;
    case 'win32':
      rmSync(windowsStorePath(account), { force: true });
      return;
    default:
      throw Object.assign(new Error('no keychain on this platform'), { code: 'unsupported' });
  }
}
