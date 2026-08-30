/**
 * `meta/global` — the unencrypted record that declares the storage format
 * version and the sync id of every engine.
 *
 * FireSync treats this as read-mostly. It refuses to touch an account whose
 * `storageVersion` is not 5, and it watches each engine's `syncID`: when
 * Firefox resets an engine (a "disconnect and reconnect", a password reset)
 * the syncID changes, and every local high-water mark for that engine must be
 * discarded or FireSync would silently skip records.
 */

export const STORAGE_VERSION = 5;

export interface EngineMeta {
  version: number;
  syncID: string;
}

export interface MetaGlobal {
  storageVersion: number;
  syncID: string;
  engines: Record<string, EngineMeta>;
  declined?: string[];
}

export class UnsupportedStorageVersionError extends Error {
  constructor(readonly found: number) {
    super(
      `this account uses Sync storage version ${found}; FireSync speaks version ${STORAGE_VERSION}`,
    );
    this.name = 'UnsupportedStorageVersionError';
  }
}

export function parseMetaGlobal(value: unknown): MetaGlobal {
  if (typeof value !== 'object' || value === null) {
    throw new Error('meta/global is not an object');
  }
  const meta = value as Partial<MetaGlobal>;
  if (typeof meta.storageVersion !== 'number') {
    throw new Error('meta/global has no storageVersion');
  }
  if (meta.storageVersion !== STORAGE_VERSION) {
    throw new UnsupportedStorageVersionError(meta.storageVersion);
  }
  return {
    storageVersion: meta.storageVersion,
    syncID: typeof meta.syncID === 'string' ? meta.syncID : '',
    engines: (meta.engines ?? {}) as Record<string, EngineMeta>,
    declined: meta.declined ?? [],
  };
}

/**
 * Whether a locally cached sync id still matches the server. A mismatch means
 * the engine was reset and every incremental marker for it is invalid.
 */
export function engineWasReset(
  meta: MetaGlobal,
  engine: string,
  cachedSyncId: string | null,
): boolean {
  const remote = meta.engines[engine]?.syncID ?? null;
  if (remote === null) return false;
  if (cachedSyncId === null) return false;
  return remote !== cachedSyncId;
}

/** Whether the user has this engine switched on in Firefox at all. */
export function engineIsEnabled(meta: MetaGlobal, engine: string): boolean {
  if (meta.declined?.includes(engine)) return false;
  return engine in meta.engines;
}
