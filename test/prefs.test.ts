import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryArea } from '../src/common/storage.ts';
import { PreferencesStore } from '../src/prefs/store.ts';
import { DEFAULT_GLOBAL_PREFERENCES } from '../src/prefs/types.ts';
import { mergePrefs, newPrefsRecord, validatePrefsRecord } from '../src/sync15/engines/prefs.ts';

describe('PreferencesStore', () => {
  let store: PreferencesStore;

  beforeEach(() => {
    store = new PreferencesStore(new MemoryArea());
  });

  it('returns the defaults before anything is stored', async () => {
    expect(await store.global()).toEqual(DEFAULT_GLOBAL_PREFERENCES);
  });

  it('defaults autofill-on-load to off', async () => {
    expect((await store.global()).autoFillOnLoad).toBe(false);
  });

  it('defaults credit cards to off', async () => {
    expect((await store.global()).engines.creditcards).toBe(false);
  });

  it('merges partial updates without dropping other keys', async () => {
    await store.setGlobal({ lockTimeoutMinutes: 5 });
    const prefs = await store.global();
    expect(prefs.lockTimeoutMinutes).toBe(5);
    expect(prefs.inlineMenu).toBe(DEFAULT_GLOBAL_PREFERENCES.inlineMenu);
  });

  it('merges engine flags rather than replacing the object', async () => {
    await store.setGlobal({ engines: { passwords: false } as never });
    const prefs = await store.global();
    expect(prefs.engines.passwords).toBe(false);
    expect(prefs.engines.addresses).toBe(true);
  });

  it('stores per-site preferences keyed by origin', async () => {
    await store.setForUrl('https://example.com/login?x=1', { neverSave: true });
    const sites = await store.allSites();
    expect(Object.keys(sites)).toEqual(['https://example.com']);
    expect(sites['https://example.com']).toMatchObject({
      origin: 'https://example.com',
      neverSave: true,
    });
    expect(sites['https://example.com']?.updatedAt).toBeGreaterThan(0);
  });

  it('treats different ports as different sites', async () => {
    await store.setForUrl('http://localhost:3000/', { neverSave: true });
    expect(await store.forUrl('http://localhost:4000/')).toBeNull();
  });

  it('refuses to store preferences for an unusable URL', async () => {
    await expect(store.setForUrl('about:blank', {})).rejects.toThrow(/cannot store/);
  });

  it('clears a site override', async () => {
    await store.setForUrl('https://example.com', { neverSave: true });
    await store.clearForUrl('https://example.com');
    expect(await store.forUrl('https://example.com')).toBeNull();
  });

  describe('resolved settings', () => {
    it('lets a site disable the save prompt', async () => {
      expect(await store.savePromptEnabled('https://example.com/')).toBe(true);
      await store.neverSaveFor('https://example.com/');
      expect(await store.savePromptEnabled('https://example.com/')).toBe(false);
    });

    it('lets the global setting disable the save prompt everywhere', async () => {
      await store.setGlobal({ savePrompt: false });
      expect(await store.savePromptEnabled('https://example.com/')).toBe(false);
    });

    it('prefers the site inline-menu mode over the global one', async () => {
      await store.setGlobal({ inlineMenu: 'on' });
      await store.setForUrl('https://example.com', { inlineMenu: 'off' });
      expect(await store.inlineMenuMode('https://example.com/page')).toBe('off');
      expect(await store.inlineMenuMode('https://other.test/')).toBe('on');
    });

    it('prefers the site match strategy over the global default', async () => {
      await store.setForUrl('https://example.com', { matchStrategy: 'exact' });
      expect(await store.matchStrategy('https://example.com/x')).toBe('exact');
      expect(await store.matchStrategy('https://other.test/')).toBe('domain');
    });

    it('lets a site opt in to autofill on load', async () => {
      expect(await store.autoFillEnabled('https://example.com/')).toBe(false);
      await store.setForUrl('https://example.com', { autoFillOnLoad: true });
      expect(await store.autoFillEnabled('https://example.com/')).toBe(true);
    });
  });
});

describe('firesync-prefs sync record', () => {
  it('validates a well-formed record', () => {
    expect(validatePrefsRecord(newPrefsRecord({}))).toBe(true);
    expect(validatePrefsRecord({ id: 'x' })).toBe(false);
    expect(validatePrefsRecord(null)).toBe(false);
  });

  it('merges site-by-site with the newer side winning', () => {
    const local = newPrefsRecord(
      {
        'https://a.test': { origin: 'https://a.test', neverSave: true, updatedAt: 2000 },
        'https://only-local.test': { origin: 'https://only-local.test', updatedAt: 1 },
      },
      2000,
    );
    const remote = newPrefsRecord(
      {
        'https://a.test': { origin: 'https://a.test', neverSave: false, updatedAt: 1000 },
        'https://only-remote.test': { origin: 'https://only-remote.test', updatedAt: 1 },
      },
      1000,
    );

    const merged = mergePrefs(local, remote);
    expect(merged.sites['https://a.test']?.neverSave).toBe(true);
    expect(merged.sites['https://only-local.test']).toBeDefined();
    expect(merged.sites['https://only-remote.test']).toBeDefined();
    expect(merged.updatedAt).toBe(2000);
  });

  it('lets the remote side win when it is newer', () => {
    const local = newPrefsRecord(
      { 'https://a.test': { origin: 'https://a.test', neverSave: true, updatedAt: 10 } },
      10,
    );
    const remote = newPrefsRecord(
      { 'https://a.test': { origin: 'https://a.test', neverSave: false, updatedAt: 99 } },
      99,
    );
    expect(mergePrefs(local, remote).sites['https://a.test']?.neverSave).toBe(false);
  });
});
