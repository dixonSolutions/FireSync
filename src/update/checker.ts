/**
 * FireSync's own update engine.
 *
 * A self-hosted extension does not get Chrome's update machinery for free:
 *
 *   - **Policy-installed** builds do auto-update, from the `update_url` in the
 *     manifest. `chrome.runtime.requestUpdateCheck()` nudges that along.
 *   - **Unpacked and drag-installed** builds never auto-update at all. Chrome
 *     has no mechanism for it and an extension cannot install a CRX over
 *     itself — that would be a self-modifying-code hole, and rightly closed.
 *
 * So this checks a small JSON manifest, compares versions, and *tells the user*
 * with a link. It cannot install anything, and does not pretend to. Where Chrome
 * can do the real thing, the background wrapper asks it to as well.
 *
 * The whole class is pure except for an injected `fetch` and clock, so the
 * behaviour that matters — never nagging, never trusting a malformed manifest,
 * respecting "off" absolutely — is testable without a browser.
 */

import type { KeyValueArea } from '../common/storage.ts';
import { isNewer, isValidVersion } from './version.ts';
import {
  DEFAULT_UPDATE_SETTINGS,
  emptyUpdateState,
  MAX_INTERVAL_HOURS,
  MIN_INTERVAL_HOURS,
} from './types.ts';
import type { UpdateManifest, UpdateSettings, UpdateState } from './types.ts';

export const UPDATE_STATE_KEY = 'firesync.updates.state';

/** How long a failed check waits before the next automatic attempt. */
const ERROR_BACKOFF_MS = 60 * 60 * 1000;

/** Refuse a manifest larger than this; it is a few hundred bytes in practice. */
const MAX_MANIFEST_BYTES = 64 * 1024;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface UpdateCheckerOptions {
  area: KeyValueArea;
  currentVersion: string;
  settings: () => Promise<UpdateSettings>;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export class UpdateChecker {
  private readonly area: KeyValueArea;
  private readonly currentVersion: string;
  private readonly readSettings: () => Promise<UpdateSettings>;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(options: UpdateCheckerOptions) {
    this.area = options.area;
    this.currentVersion = options.currentVersion;
    this.readSettings = options.settings;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
  }

  async state(): Promise<UpdateState> {
    return (await this.area.get<UpdateState>(UPDATE_STATE_KEY)) ?? emptyUpdateState();
  }

  private async write(state: UpdateState): Promise<UpdateState> {
    await this.area.set(UPDATE_STATE_KEY, state);
    return state;
  }

  /** Hours between checks, clamped so a bad setting cannot hammer the host. */
  static clampInterval(hours: number): number {
    if (!Number.isFinite(hours)) return DEFAULT_UPDATE_SETTINGS.intervalHours;
    return Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.round(hours)));
  }

  /** Whether an automatic check is due. Always false when updates are off. */
  async isDue(): Promise<boolean> {
    const settings = await this.readSettings();
    if (settings.mode !== 'auto') return false;

    const state = await this.state();
    if (state.lastCheckedAt === null) return true;

    const interval = UpdateChecker.clampInterval(settings.intervalHours) * 3600_000;
    const wait = state.lastError ? Math.min(interval, ERROR_BACKOFF_MS) : interval;
    return this.now() - state.lastCheckedAt >= wait;
  }

  /**
   * Check for an update.
   *
   * `force` is what the "Check now" button passes: it bypasses the timer and
   * works in `manual` mode. It does **not** override `off` — that setting means
   * "do not contact the update host", and a UI button must not quietly undo it.
   */
  async check(force = false): Promise<UpdateState> {
    const settings = await this.readSettings();

    if (settings.mode === 'off') return this.state();
    if (!force && !(await this.isDue())) return this.state();

    const previous = await this.state();

    let manifest: UpdateManifest;
    try {
      manifest = await this.fetchManifest(settings.manifestUrl);
    } catch (error) {
      return this.write({
        ...previous,
        lastCheckedAt: this.now(),
        lastError: error instanceof Error ? error.message : String(error),
      });
    }

    const available = isNewer(manifest.version, this.currentVersion) ? manifest : null;

    return this.write({
      lastCheckedAt: this.now(),
      lastError: null,
      available,
      // A newly-published version resets a previous dismissal; the user
      // dismissed that release, not every future one.
      dismissedVersion:
        available && previous.dismissedVersion === available.version
          ? previous.dismissedVersion
          : available
            ? null
            : previous.dismissedVersion,
    });
  }

  /** Stop badging for this version. The next release badges again. */
  async dismiss(version: string): Promise<UpdateState> {
    const state = await this.state();
    return this.write({ ...state, dismissedVersion: version });
  }

  /** Whether the UI should be drawing attention to an update right now. */
  async shouldNotify(): Promise<boolean> {
    const state = await this.state();
    if (!state.available) return false;
    if (state.available.critical) return true;
    return state.dismissedVersion !== state.available.version;
  }

  async reset(): Promise<UpdateState> {
    return this.write(emptyUpdateState());
  }

  // ------------------------------------------------------------------ fetching

  private async fetchManifest(url: string): Promise<UpdateManifest> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new Error('the update manifest URL must be https');
    }

    const response = await this.fetchImpl(url, {
      method: 'GET',
      // The manifest changes rarely and Chrome caches aggressively; a release
      // the user cannot see for hours defeats the point.
      cache: 'no-cache',
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`update manifest returned ${response.status}`);
    }

    const text = await response.text();
    if (text.length > MAX_MANIFEST_BYTES) {
      throw new Error(`update manifest is ${text.length} bytes; refusing to parse it`);
    }

    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(text);
    } catch {
      throw new Error('update manifest is not valid JSON');
    }

    return normaliseManifest(parsedManifest);
  }
}

/**
 * Validate a manifest into a known shape.
 *
 * Download URLs are required to be https and are dropped otherwise: the whole
 * value of the manifest is that it tells a user where to get a binary, and
 * pointing that at plaintext http would be worse than pointing it nowhere.
 */
export function normaliseManifest(value: unknown): UpdateManifest {
  if (typeof value !== 'object' || value === null) {
    throw new Error('update manifest is not an object');
  }
  const raw = value as Record<string, unknown>;

  if (typeof raw['version'] !== 'string' || !isValidVersion(raw['version'])) {
    throw new Error(`update manifest has no usable version (got ${String(raw['version'])})`);
  }

  const manifest: UpdateManifest = { version: raw['version'] };

  const httpsUrl = (candidate: unknown): string | undefined => {
    if (typeof candidate !== 'string') return undefined;
    try {
      return new URL(candidate).protocol === 'https:' ? candidate : undefined;
    } catch {
      return undefined;
    }
  };

  const crx = httpsUrl(raw['crx']);
  const zip = httpsUrl(raw['zip']);
  const releaseUrl = httpsUrl(raw['releaseUrl']);
  if (crx) manifest.crx = crx;
  if (zip) manifest.zip = zip;
  if (releaseUrl) manifest.releaseUrl = releaseUrl;

  if (typeof raw['releasedAt'] === 'string') manifest.releasedAt = raw['releasedAt'];
  if (typeof raw['notes'] === 'string') manifest.notes = raw['notes'].slice(0, 2000);
  if (typeof raw['minimumChromeVersion'] === 'string') {
    manifest.minimumChromeVersion = raw['minimumChromeVersion'];
  }
  if (raw['critical'] === true) manifest.critical = true;

  return manifest;
}
