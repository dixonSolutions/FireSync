/**
 * Preferences storage.
 *
 * Preferences are deliberately NOT sealed with the vault key: the popup and
 * the content script need to know "is the inline menu off for this site?"
 * before the vault is unlocked, and none of these values are secrets. The one
 * thing that is arguably sensitive — the list of origins the user visits — is
 * no more exposed here than it is in the browser's own history.
 */

import type { KeyValueArea } from '../common/storage.ts';
import { originForStorage } from '../match/uri.ts';
import { DEFAULT_GLOBAL_PREFERENCES } from './types.ts';
import type {
  GlobalPreferences,
  InlineMenuMode,
  PreferencesSnapshot,
  SitePreferences,
  UriMatchStrategy,
} from './types.ts';

export const PREFS_KEY = {
  global: 'firesync.prefs.global',
  sites: 'firesync.prefs.sites',
} as const;

export class PreferencesStore {
  constructor(private readonly area: KeyValueArea) {}

  async global(): Promise<GlobalPreferences> {
    const stored = await this.area.get<Partial<GlobalPreferences>>(PREFS_KEY.global);
    return {
      ...DEFAULT_GLOBAL_PREFERENCES,
      ...stored,
      engines: { ...DEFAULT_GLOBAL_PREFERENCES.engines, ...stored?.engines },
    };
  }

  async setGlobal(patch: Partial<GlobalPreferences>): Promise<GlobalPreferences> {
    const next = { ...(await this.global()), ...patch };
    await this.area.set(PREFS_KEY.global, next);
    return next;
  }

  async allSites(): Promise<Record<string, SitePreferences>> {
    return (await this.area.get<Record<string, SitePreferences>>(PREFS_KEY.sites)) ?? {};
  }

  /** Preferences for a page URL, falling back to the global defaults. */
  async forUrl(pageUrl: string): Promise<SitePreferences | null> {
    const origin = originForStorage(pageUrl);
    if (!origin) return null;
    return (await this.allSites())[origin] ?? null;
  }

  async setForUrl(pageUrl: string, patch: Partial<SitePreferences>): Promise<SitePreferences> {
    const origin = originForStorage(pageUrl);
    if (!origin) throw new Error(`cannot store preferences for ${pageUrl}`);
    const sites = await this.allSites();
    const next: SitePreferences = {
      ...(sites[origin] ?? { origin }),
      ...patch,
      origin,
      updatedAt: Date.now(),
    };
    sites[origin] = next;
    await this.area.set(PREFS_KEY.sites, sites);
    return next;
  }

  async clearForUrl(pageUrl: string): Promise<void> {
    const origin = originForStorage(pageUrl);
    if (!origin) return;
    const sites = await this.allSites();
    delete sites[origin];
    await this.area.set(PREFS_KEY.sites, sites);
  }

  /** Replace the whole site map — used when applying a synced prefs record. */
  async replaceSites(sites: Record<string, SitePreferences>): Promise<void> {
    await this.area.set(PREFS_KEY.sites, sites);
  }

  async snapshot(): Promise<PreferencesSnapshot> {
    return { global: await this.global(), sites: await this.allSites() };
  }

  // ---------------------------------------------------- resolved, per-request

  /** Should we offer to save credentials on this page? */
  async savePromptEnabled(pageUrl: string): Promise<boolean> {
    const [global, site] = await Promise.all([this.global(), this.forUrl(pageUrl)]);
    if (site?.neverSave) return false;
    return global.savePrompt;
  }

  /** Inline menu mode for this page, site setting winning over the global one. */
  async inlineMenuMode(pageUrl: string): Promise<InlineMenuMode> {
    const [global, site] = await Promise.all([this.global(), this.forUrl(pageUrl)]);
    return site?.inlineMenu ?? global.inlineMenu;
  }

  /** Match strategy for this page. */
  async matchStrategy(pageUrl: string): Promise<UriMatchStrategy> {
    const [global, site] = await Promise.all([this.global(), this.forUrl(pageUrl)]);
    return site?.matchStrategy ?? global.defaultMatchStrategy;
  }

  /** Fill without asking? Only when the user has explicitly opted in. */
  async autoFillEnabled(pageUrl: string): Promise<boolean> {
    const [global, site] = await Promise.all([this.global(), this.forUrl(pageUrl)]);
    return site?.autoFillOnLoad ?? global.autoFillOnLoad;
  }

  /** Convenience: the "never for this site" toggle behind the save bar. */
  async neverSaveFor(pageUrl: string): Promise<void> {
    await this.setForUrl(pageUrl, { neverSave: true });
  }
}
