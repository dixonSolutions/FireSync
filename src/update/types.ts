/** How aggressively FireSync looks for its own updates. */
export type UpdateMode =
  /** Check on a timer and tell the user when something is available. */
  | 'auto'
  /** Only ever check when the user presses the button. */
  | 'manual'
  /** Never check, and never reach out to the update host. */
  | 'off';

/** The document served at the update manifest URL. */
export interface UpdateManifest {
  version: string;
  /** ISO 8601. Shown in the UI; not used for the comparison. */
  releasedAt?: string;
  /** Short human-readable summary of the release. */
  notes?: string;
  /** Where to download the signed CRX. */
  crx?: string;
  /** Where to download the unpacked zip, for developer-mode installs. */
  zip?: string;
  /** Link to the full release notes. */
  releaseUrl?: string;
  /** Minimum Chrome version this build supports. */
  minimumChromeVersion?: string;
  /** Set when a release must not be skipped over, e.g. a security fix. */
  critical?: boolean;
}

export interface UpdateSettings {
  mode: UpdateMode;
  /** Hours between automatic checks. Clamped to a sane range on use. */
  intervalHours: number;
  /** Where the update manifest lives. Configurable for self-hosting. */
  manifestUrl: string;
}

export interface UpdateState {
  /** Epoch ms of the last completed check, successful or not. */
  lastCheckedAt: number | null;
  /** Message from the last failed check, cleared on success. */
  lastError: string | null;
  /** The available release, only when it is newer than what is running. */
  available: UpdateManifest | null;
  /** A version the user chose to ignore; suppresses the badge for it. */
  dismissedVersion: string | null;
}

export function emptyUpdateState(): UpdateState {
  return { lastCheckedAt: null, lastError: null, available: null, dismissedVersion: null };
}

/**
 * The project's own release feed. Overridable in settings so a fork or an
 * enterprise mirror can point somewhere else without a rebuild.
 */
export const DEFAULT_UPDATE_MANIFEST_URL =
  'https://dixonsolutions.github.io/FireSync/update.json';

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  mode: 'auto',
  intervalHours: 24,
  manifestUrl: DEFAULT_UPDATE_MANIFEST_URL,
};

export const MIN_INTERVAL_HOURS = 1;
export const MAX_INTERVAL_HOURS = 24 * 14;
