/**
 * Two-way reconciliation between the local vault and a Sync collection.
 *
 * The policy is deliberately last-writer-wins **per record**, never per field.
 * Field-merging two versions of a login would invent a username/password pair
 * that never existed on either side — the worst possible failure mode for a
 * password manager. Firefox itself resolves logins the same way, using
 * `timePasswordChanged` as the authority.
 *
 * This module is pure: no network, no storage, no clock. That is what makes
 * the conflict matrix exhaustively testable.
 */

/** A record as it exists locally. `data` is null for a tombstone. */
export interface LocalRecord<T> {
  id: string;
  data: T | null;
  deleted: boolean;
  /**
   * Authority timestamp in **milliseconds** — for logins this is
   * `timePasswordChanged`, otherwise the local edit time.
   */
  authorityTime: number;
  /** Server timestamp (seconds) this version was last confirmed against. */
  syncedAt: number | null;
  /** Local edits not yet pushed. */
  dirty: boolean;
}

/** A record as it exists on the server. */
export interface RemoteRecord<T> {
  id: string;
  data: T | null;
  deleted: boolean;
  /** `modified` from the BSO, in seconds. */
  modified: number;
  /** Authority timestamp in milliseconds, extracted from the payload. */
  authorityTime: number;
}

export type Resolution = 'local' | 'remote';

export interface Conflict {
  id: string;
  resolution: Resolution;
  reason: string;
}

export interface ReconcileResult<T> {
  /** Remote versions that should overwrite (or create) the local record. */
  applyLocally: RemoteRecord<T>[];
  /** Local versions that should be pushed to the server. */
  uploadRemotely: LocalRecord<T>[];
  /** Records that changed on both sides, and how each was decided. */
  conflicts: Conflict[];
  /** Remote tombstones for records we never had — nothing to do. */
  ignoredTombstones: string[];
}

export interface ReconcileOptions<T> {
  /**
   * Decide a genuine conflict. Defaults to comparing `authorityTime`, with a
   * tombstone winning ties so a deletion is never silently resurrected.
   */
  resolve?: (local: LocalRecord<T>, remote: RemoteRecord<T>) => Resolution;
}

function defaultResolve<T>(local: LocalRecord<T>, remote: RemoteRecord<T>): Resolution {
  if (local.authorityTime !== remote.authorityTime) {
    return local.authorityTime > remote.authorityTime ? 'local' : 'remote';
  }
  // Equal timestamps: a delete beats an edit, then remote beats local so that
  // two devices racing converge on the same answer instead of ping-ponging.
  if (local.deleted !== remote.deleted) return local.deleted ? 'local' : 'remote';
  return 'remote';
}

/**
 * Reconcile a set of local records against the remote records that changed
 * since the last sync.
 *
 * `remote` should be *only* the records newer than the last high-water mark;
 * anything not present there is assumed unchanged on the server.
 */
export function reconcile<T>(
  local: readonly LocalRecord<T>[],
  remote: readonly RemoteRecord<T>[],
  options: ReconcileOptions<T> = {},
): ReconcileResult<T> {
  const resolve = options.resolve ?? defaultResolve;
  const localById = new Map(local.map((record) => [record.id, record]));
  const remoteById = new Map(remote.map((record) => [record.id, record]));

  const result: ReconcileResult<T> = {
    applyLocally: [],
    uploadRemotely: [],
    conflicts: [],
    ignoredTombstones: [],
  };

  for (const remoteRecord of remote) {
    const localRecord = localById.get(remoteRecord.id);

    if (!localRecord) {
      if (remoteRecord.deleted) {
        // A tombstone for something we have never seen. Nothing to apply, and
        // re-uploading it would keep it alive forever.
        result.ignoredTombstones.push(remoteRecord.id);
      } else {
        result.applyLocally.push(remoteRecord);
      }
      continue;
    }

    if (!localRecord.dirty) {
      // Clean locally: the server is authoritative by definition.
      if (localRecord.syncedAt === null || remoteRecord.modified > localRecord.syncedAt) {
        result.applyLocally.push(remoteRecord);
      }
      continue;
    }

    const resolution = resolve(localRecord, remoteRecord);
    result.conflicts.push({
      id: remoteRecord.id,
      resolution,
      reason:
        resolution === 'local'
          ? `local edit at ${localRecord.authorityTime} beats remote ${remoteRecord.authorityTime}`
          : `remote edit at ${remoteRecord.authorityTime} beats local ${localRecord.authorityTime}`,
    });
    if (resolution === 'local') result.uploadRemotely.push(localRecord);
    else result.applyLocally.push(remoteRecord);
  }

  for (const localRecord of local) {
    if (!localRecord.dirty) continue;
    if (remoteById.has(localRecord.id)) continue; // already handled above
    result.uploadRemotely.push(localRecord);
  }

  return result;
}

/**
 * Records that can be dropped from the local store: tombstones that both sides
 * agree on and that are older than `maxAgeMs`. Keeping tombstones forever grows
 * the vault without bound; dropping them too early resurrects deleted logins on
 * a device that has been offline a long time.
 */
export function expiredTombstones<T>(
  local: readonly LocalRecord<T>[],
  now: number,
  maxAgeMs: number,
): string[] {
  return local
    .filter((record) => record.deleted && !record.dirty && now - record.authorityTime > maxAgeMs)
    .map((record) => record.id);
}
