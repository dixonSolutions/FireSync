/**
 * `firesync-prefs` — a custom Sync collection.
 *
 * Sync 1.5 accepts arbitrary collection names, and Firefox ignores collections
 * it does not have an engine for. That gives FireSync a free, end-to-end
 * encrypted, cross-device home for its own per-site settings without touching
 * anything Firefox cares about, and without a FireSync server.
 *
 * It is intentionally NOT listed in `meta/global`: declaring an engine Firefox
 * does not know about is the one thing that could confuse a real Firefox
 * client.
 */

import type { SitePreferences } from '../../prefs/types.ts';

export const PREFS_COLLECTION = 'firesync-prefs';
export const PREFS_RECORD_ID = 'site-preferences';
export const PREFS_SCHEMA_VERSION = 1;

export interface PrefsRecord {
  id: string;
  version: number;
  updatedAt: number;
  sites: Record<string, SitePreferences>;
}

export function newPrefsRecord(
  sites: Record<string, SitePreferences>,
  now = Date.now(),
): PrefsRecord {
  return {
    id: PREFS_RECORD_ID,
    version: PREFS_SCHEMA_VERSION,
    updatedAt: now,
    sites,
  };
}

export function validatePrefsRecord(value: unknown): value is PrefsRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['version'] === 'number' &&
    typeof record['sites'] === 'object' &&
    record['sites'] !== null
  );
}

/**
 * Merge two preference sets. Preferences are small, independent, per-origin
 * values, so unlike logins a field-level merge is safe here — and it is what
 * users expect when they set "never save" on one machine.
 */
export function mergePrefs(local: PrefsRecord, remote: PrefsRecord): PrefsRecord {
  const sites: Record<string, SitePreferences> = { ...remote.sites };
  for (const [origin, localSite] of Object.entries(local.sites)) {
    const remoteSite = remote.sites[origin];
    if (!remoteSite || (localSite.updatedAt ?? 0) >= (remoteSite.updatedAt ?? 0)) {
      sites[origin] = localSite;
    }
  }
  return {
    id: PREFS_RECORD_ID,
    version: PREFS_SCHEMA_VERSION,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    sites,
  };
}
