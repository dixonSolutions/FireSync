import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryArea } from '../src/common/storage.ts';
import { normaliseManifest, UPDATE_STATE_KEY, UpdateChecker } from '../src/update/checker.ts';
import {
  compareVersions,
  InvalidVersionError,
  isNewer,
  isValidVersion,
  parseVersion,
} from '../src/update/version.ts';
import { DEFAULT_UPDATE_SETTINGS } from '../src/update/types.ts';
import type { UpdateSettings } from '../src/update/types.ts';

describe('version parsing', () => {
  it('accepts one to four components', () => {
    expect(parseVersion('1')).toEqual([1]);
    expect(parseVersion('1.2.3.4')).toEqual([1, 2, 3, 4]);
  });

  it('rejects what Chrome rejects', () => {
    for (const bad of ['', '1.2.3.4.5', '1.2.3-beta', 'v1.0', '1..2', '1.2.', '65536', 'abc']) {
      expect(() => parseVersion(bad)).toThrow(InvalidVersionError);
      expect(isValidVersion(bad)).toBe(false);
    }
  });

  it('treats missing components as zero', () => {
    expect(compareVersions('1.2', '1.2.0.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
  });

  it('compares numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.10')).toBe(-1);
  });

  it('orders a realistic release sequence', () => {
    const versions = ['0.1.0', '0.2.0', '0.10.0', '1.0.0', '1.0.1'];
    for (let i = 1; i < versions.length; i++) {
      expect(compareVersions(versions[i]!, versions[i - 1]!)).toBe(1);
    }
  });

  it('isNewer is false for equal, older, and malformed versions', () => {
    expect(isNewer('1.0.1', '1.0.0')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.9.9', '1.0.0')).toBe(false);
    expect(isNewer('not-a-version', '1.0.0')).toBe(false);
    expect(isNewer('1.0.1', 'garbage')).toBe(false);
  });
});

describe('normaliseManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(
      normaliseManifest({
        version: '1.2.0',
        releasedAt: '2026-08-30T00:00:00Z',
        notes: 'Fixes things',
        crx: 'https://example.com/a.crx',
        zip: 'https://example.com/a.zip',
        releaseUrl: 'https://example.com/releases/1.2.0',
        critical: true,
      }),
    ).toEqual({
      version: '1.2.0',
      releasedAt: '2026-08-30T00:00:00Z',
      notes: 'Fixes things',
      crx: 'https://example.com/a.crx',
      zip: 'https://example.com/a.zip',
      releaseUrl: 'https://example.com/releases/1.2.0',
      critical: true,
    });
  });

  it('drops non-https download URLs rather than offering them', () => {
    const manifest = normaliseManifest({
      version: '1.0.0',
      crx: 'http://example.com/a.crx',
      zip: 'javascript:alert(1)',
      releaseUrl: 'not a url',
    });
    expect(manifest.crx).toBeUndefined();
    expect(manifest.zip).toBeUndefined();
    expect(manifest.releaseUrl).toBeUndefined();
  });

  it('rejects a manifest with no usable version', () => {
    expect(() => normaliseManifest({ version: 'v2' })).toThrow(/no usable version/);
    expect(() => normaliseManifest({})).toThrow(/no usable version/);
    expect(() => normaliseManifest(null)).toThrow(/not an object/);
  });

  it('truncates absurd release notes', () => {
    const manifest = normaliseManifest({ version: '1.0.0', notes: 'x'.repeat(9000) });
    expect(manifest.notes).toHaveLength(2000);
  });

  it('ignores critical unless it is exactly true', () => {
    expect(normaliseManifest({ version: '1.0.0', critical: 'yes' }).critical).toBeUndefined();
  });
});

describe('UpdateChecker', () => {
  let area: MemoryArea;
  let clock: number;
  let settings: UpdateSettings;
  let served: unknown;
  let status: number;
  let calls: string[];

  const MANIFEST_URL = 'https://updates.example.com/update.json';

  function makeChecker(currentVersion = '0.1.0') {
    return new UpdateChecker({
      area,
      currentVersion,
      settings: async () => settings,
      now: () => clock,
      fetchImpl: async (url) => {
        calls.push(url);
        if (status !== 200) return new Response('nope', { status });
        return new Response(JSON.stringify(served), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
  }

  beforeEach(() => {
    area = new MemoryArea();
    clock = 1_700_000_000_000;
    settings = { ...DEFAULT_UPDATE_SETTINGS, manifestUrl: MANIFEST_URL };
    served = { version: '0.2.0', notes: 'Newer', crx: 'https://example.com/a.crx' };
    status = 200;
    calls = [];
  });

  it('finds a newer release', async () => {
    const state = await makeChecker().check(true);
    expect(state.available?.version).toBe('0.2.0');
    expect(state.lastError).toBeNull();
    expect(state.lastCheckedAt).toBe(clock);
  });

  it('reports nothing when the published version is not newer', async () => {
    served = { version: '0.1.0' };
    expect((await makeChecker().check(true)).available).toBeNull();

    served = { version: '0.0.9' };
    expect((await makeChecker().check(true)).available).toBeNull();
  });

  it('never contacts the host when updates are off', async () => {
    settings = { ...settings, mode: 'off' };
    const checker = makeChecker();

    await checker.check();
    await checker.check(true); // even the explicit button must not override "off"

    expect(calls).toEqual([]);
    expect((await checker.state()).lastCheckedAt).toBeNull();
  });

  it('in manual mode checks only when asked', async () => {
    settings = { ...settings, mode: 'manual' };
    const checker = makeChecker();

    await checker.check();
    expect(calls).toEqual([]);
    expect(await checker.isDue()).toBe(false);

    await checker.check(true);
    expect(calls).toEqual([MANIFEST_URL]);
  });

  it('respects the interval in auto mode', async () => {
    const checker = makeChecker();
    expect(await checker.isDue()).toBe(true);

    await checker.check();
    expect(calls).toHaveLength(1);
    expect(await checker.isDue()).toBe(false);

    await checker.check();
    expect(calls).toHaveLength(1);

    clock += 25 * 3600_000;
    expect(await checker.isDue()).toBe(true);
    await checker.check();
    expect(calls).toHaveLength(2);
  });

  it('clamps a nonsensical interval', () => {
    expect(UpdateChecker.clampInterval(0)).toBe(1);
    expect(UpdateChecker.clampInterval(-5)).toBe(1);
    expect(UpdateChecker.clampInterval(9_999_999)).toBe(24 * 14);
    expect(UpdateChecker.clampInterval(Number.NaN)).toBe(DEFAULT_UPDATE_SETTINGS.intervalHours);
  });

  it('retries sooner after a failure, then recovers', async () => {
    status = 503;
    const checker = makeChecker();

    let state = await checker.check(true);
    expect(state.lastError).toMatch(/503/);
    expect(state.available).toBeNull();

    // Backoff is an hour, shorter than the 24-hour interval.
    clock += 30 * 60_000;
    expect(await checker.isDue()).toBe(false);
    clock += 31 * 60_000;
    expect(await checker.isDue()).toBe(true);

    status = 200;
    state = await checker.check();
    expect(state.lastError).toBeNull();
    expect(state.available?.version).toBe('0.2.0');
  });

  it('keeps the previously known release when a check fails', async () => {
    const checker = makeChecker();
    await checker.check(true);

    status = 500;
    clock += 25 * 3600_000;
    const state = await checker.check();

    expect(state.lastError).toMatch(/500/);
    expect(state.available?.version).toBe('0.2.0');
  });

  it('rejects a malformed manifest without inventing an update', async () => {
    served = { version: 'banana' };
    const state = await makeChecker().check(true);
    expect(state.available).toBeNull();
    expect(state.lastError).toMatch(/no usable version/);
  });

  it('refuses an http manifest URL', async () => {
    settings = { ...settings, manifestUrl: 'http://updates.example.com/update.json' };
    const state = await makeChecker().check(true);
    expect(calls).toEqual([]);
    expect(state.lastError).toMatch(/must be https/);
  });

  it('honours a dismissal until the next release', async () => {
    const checker = makeChecker();
    await checker.check(true);
    expect(await checker.shouldNotify()).toBe(true);

    await checker.dismiss('0.2.0');
    expect(await checker.shouldNotify()).toBe(false);

    // The same version stays dismissed across a re-check…
    clock += 25 * 3600_000;
    await checker.check();
    expect(await checker.shouldNotify()).toBe(false);

    // …but a newer one does not.
    served = { version: '0.3.0' };
    clock += 25 * 3600_000;
    await checker.check();
    expect(await checker.shouldNotify()).toBe(true);
  });

  it('always notifies for a critical release, even if dismissed', async () => {
    served = { version: '0.2.0', critical: true };
    const checker = makeChecker();
    await checker.check(true);
    await checker.dismiss('0.2.0');
    expect(await checker.shouldNotify()).toBe(true);
  });

  it('does not notify when there is nothing to install', async () => {
    served = { version: '0.1.0' };
    const checker = makeChecker();
    await checker.check(true);
    expect(await checker.shouldNotify()).toBe(false);
  });

  it('persists state across instances', async () => {
    await makeChecker().check(true);
    expect(await area.get(UPDATE_STATE_KEY)).toMatchObject({
      available: { version: '0.2.0' },
    });
    expect((await makeChecker().state()).available?.version).toBe('0.2.0');
  });

  it('reset clears everything', async () => {
    const checker = makeChecker();
    await checker.check(true);
    const state = await checker.reset();
    expect(state).toEqual({
      lastCheckedAt: null,
      lastError: null,
      available: null,
      dismissedVersion: null,
    });
  });

  it('refuses an oversized manifest body', async () => {
    const checker = new UpdateChecker({
      area,
      currentVersion: '0.1.0',
      settings: async () => settings,
      now: () => clock,
      fetchImpl: async () => new Response('x'.repeat(70_000), { status: 200 }),
    });
    expect((await checker.check(true)).lastError).toMatch(/refusing to parse/);
  });
});
