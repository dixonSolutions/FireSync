/** Locating Firefox profiles on this machine. */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** Every directory Firefox might keep profiles in, for this platform. */
export function profileRoots() {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return [
        join(home, 'Library', 'Application Support', 'Firefox', 'Profiles'),
        join(home, 'Library', 'Application Support', 'Firefox'),
      ];
    case 'win32':
      return [
        join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox', 'Profiles'),
      ];
    default:
      return [
        join(home, '.mozilla', 'firefox'),
        join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
        join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
      ];
  }
}

/** How many logins a profile holds, without decrypting any of them. */
export function countLogins(profilePath) {
  const file = join(profilePath, 'logins.json');
  if (!existsSync(file)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed.logins) ? parsed.logins.length : 0;
  } catch {
    return 0;
  }
}

/** Read `logins.json`, or an empty list if it is missing or unreadable. */
export function readLoginsFile(profilePath) {
  const file = join(profilePath, 'logins.json');
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(parsed.logins) ? parsed.logins : [];
}

/**
 * Discover profiles. Directory scanning is used rather than parsing
 * `profiles.ini`, because the ini's `Path` entries are relative in some
 * installs and absolute in others, and a directory either has the two files we
 * need or it does not.
 */
export function listProfiles() {
  const found = [];

  for (const root of profileRoots()) {
    if (!existsSync(root)) continue;

    let entries;
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(root, entry);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }

      const hasLogins =
        existsSync(join(path, 'logins.json')) && existsSync(join(path, 'key4.db'));
      if (!hasLogins) continue;

      found.push({
        name: entry.includes('.') ? entry.slice(entry.indexOf('.') + 1) : entry,
        path,
        hasLogins,
        requiresPrimaryPassword: false, // filled in by the host, which can decrypt
        loginCount: countLogins(path),
      });
    }
  }

  return found.sort((a, b) => b.loginCount - a.loginCount);
}

/** Normalise a Firefox login record into FireSync's import shape. */
export function normaliseLogin(login, username, password) {
  return {
    origin: login.hostname ?? login.origin ?? '',
    formActionOrigin: login.formSubmitURL ?? login.formActionOrigin ?? null,
    httpRealm: login.httpRealm ?? null,
    username,
    password,
    usernameField: login.usernameField ?? '',
    passwordField: login.passwordField ?? '',
    timeCreated: login.timeCreated ?? 0,
    timePasswordChanged: login.timePasswordChanged ?? login.timeCreated ?? 0,
    timeLastUsed: login.timeLastUsed ?? 0,
    timesUsed: login.timesUsed ?? 0,
  };
}
