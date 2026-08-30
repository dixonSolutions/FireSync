/** How a stored credential's origin is compared against the current page. */
export type UriMatchStrategy =
  /** eTLD+1 equality — the default, and the only safe one for most sites. */
  | 'domain'
  /** Exact hostname equality. */
  | 'host'
  /** Page URL starts with the stored origin. */
  | 'startsWith'
  /** Full URL equality. */
  | 'exact'
  /** User-supplied regular expression, anchored. */
  | 'regex'
  /** Never offer this credential automatically. */
  | 'never';

export type InlineMenuMode = 'on' | 'button-only' | 'off';

/** Per-origin settings. The "remembering preferences" half of the product. */
export interface SitePreferences {
  origin: string;
  /** Never offer to save credentials for this origin. */
  neverSave?: boolean;
  /** Credential to pre-select when several match. */
  defaultCredentialId?: string;
  autoFillOnLoad?: boolean;
  inlineMenu?: InlineMenuMode;
  matchStrategy?: UriMatchStrategy;
  /** Extra origins that should be treated as the same site. */
  equivalentDomains?: string[];
  /** Epoch ms — the merge authority for the `firesync-prefs` collection. */
  updatedAt: number;
}

import type { UpdateSettings } from '../update/types.ts';
import { DEFAULT_UPDATE_SETTINGS } from '../update/types.ts';

export interface GlobalPreferences {
  /** Show the in-field autofill menu at all. */
  inlineMenu: InlineMenuMode;
  /** Fill a single unambiguous match without being asked. Off by default: */
  /** silent filling is how clickjacking attacks harvest credentials. */
  autoFillOnLoad: boolean;
  /** Offer to save after a successful login. */
  savePrompt: boolean;
  /** Minutes of idle before the vault re-locks. 0 = never (discouraged). */
  lockTimeoutMinutes: number;
  lockOnBrowserClose: boolean;
  /** Background sync interval. */
  syncIntervalMinutes: number;
  defaultMatchStrategy: UriMatchStrategy;
  engines: {
    passwords: boolean;
    addresses: boolean;
    /** Off by default — see src/sync15/engines/creditcards.ts. */
    creditcards: boolean;
    prefs: boolean;
  };
  /** Push FireSync's own settings into the `firesync-prefs` collection. */
  syncSitePreferences: boolean;
  /** How FireSync looks for its own updates. Self-hosted builds get no
   *  update machinery from Chrome unless they were installed by policy. */
  updates: UpdateSettings;
  theme: 'system' | 'light' | 'dark';
}

export const DEFAULT_GLOBAL_PREFERENCES: GlobalPreferences = {
  inlineMenu: 'on',
  autoFillOnLoad: false,
  savePrompt: true,
  lockTimeoutMinutes: 15,
  lockOnBrowserClose: true,
  syncIntervalMinutes: 15,
  defaultMatchStrategy: 'domain',
  engines: { passwords: true, addresses: true, creditcards: false, prefs: true },
  syncSitePreferences: true,
  updates: DEFAULT_UPDATE_SETTINGS,
  theme: 'system',
};

export interface PreferencesSnapshot {
  global: GlobalPreferences;
  sites: Record<string, SitePreferences>;
}
