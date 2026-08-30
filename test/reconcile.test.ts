import { describe, expect, it } from 'vitest';
import { expiredTombstones, reconcile } from '../src/sync15/reconcile.ts';
import type { LocalRecord, RemoteRecord } from '../src/sync15/reconcile.ts';

interface Login {
  id: string;
  password: string;
}

function local(
  id: string,
  overrides: Partial<LocalRecord<Login>> = {},
): LocalRecord<Login> {
  return {
    id,
    data: { id, password: `local-${id}` },
    deleted: false,
    authorityTime: 1000,
    syncedAt: 10,
    dirty: false,
    ...overrides,
  };
}

function remote(
  id: string,
  overrides: Partial<RemoteRecord<Login>> = {},
): RemoteRecord<Login> {
  return {
    id,
    data: { id, password: `remote-${id}` },
    deleted: false,
    modified: 20,
    authorityTime: 2000,
    ...overrides,
  };
}

describe('reconcile — no conflict', () => {
  it('applies a record that only exists remotely', () => {
    const result = reconcile<Login>([], [remote('a')]);
    expect(result.applyLocally.map((r) => r.id)).toEqual(['a']);
    expect(result.uploadRemotely).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it('uploads a record that only exists locally and is dirty', () => {
    const result = reconcile<Login>([local('a', { dirty: true, syncedAt: null })], []);
    expect(result.uploadRemotely.map((r) => r.id)).toEqual(['a']);
    expect(result.applyLocally).toHaveLength(0);
  });

  it('leaves a clean local-only record alone', () => {
    const result = reconcile<Login>([local('a')], []);
    expect(result.uploadRemotely).toHaveLength(0);
    expect(result.applyLocally).toHaveLength(0);
  });

  it('takes the remote version when the local copy is clean and older', () => {
    const result = reconcile<Login>([local('a', { syncedAt: 10 })], [remote('a', { modified: 20 })]);
    expect(result.applyLocally.map((r) => r.id)).toEqual(['a']);
    expect(result.conflicts).toHaveLength(0);
  });

  it('skips a remote version the local copy has already seen', () => {
    const result = reconcile<Login>([local('a', { syncedAt: 30 })], [remote('a', { modified: 20 })]);
    expect(result.applyLocally).toHaveLength(0);
    expect(result.uploadRemotely).toHaveLength(0);
  });
});

describe('reconcile — conflicts', () => {
  it('lets the newer local edit win', () => {
    const result = reconcile<Login>(
      [local('a', { dirty: true, authorityTime: 5000 })],
      [remote('a', { authorityTime: 2000 })],
    );
    expect(result.uploadRemotely.map((r) => r.id)).toEqual(['a']);
    expect(result.applyLocally).toHaveLength(0);
    expect(result.conflicts).toEqual([
      { id: 'a', resolution: 'local', reason: expect.stringContaining('5000') },
    ]);
  });

  it('lets the newer remote edit win', () => {
    const result = reconcile<Login>(
      [local('a', { dirty: true, authorityTime: 1000 })],
      [remote('a', { authorityTime: 9000 })],
    );
    expect(result.applyLocally.map((r) => r.id)).toEqual(['a']);
    expect(result.uploadRemotely).toHaveLength(0);
    expect(result.conflicts[0]?.resolution).toBe('remote');
  });

  it('resolves an exact timestamp tie deterministically in favour of remote', () => {
    const result = reconcile<Login>(
      [local('a', { dirty: true, authorityTime: 1234 })],
      [remote('a', { authorityTime: 1234 })],
    );
    expect(result.conflicts[0]?.resolution).toBe('remote');
  });

  it('lets a local deletion beat a remote edit at the same timestamp', () => {
    const result = reconcile<Login>(
      [local('a', { dirty: true, deleted: true, data: null, authorityTime: 1234 })],
      [remote('a', { authorityTime: 1234 })],
    );
    expect(result.conflicts[0]?.resolution).toBe('local');
    expect(result.uploadRemotely[0]?.deleted).toBe(true);
  });

  it('accepts a caller-supplied resolver', () => {
    const result = reconcile<Login>(
      [local('a', { dirty: true, authorityTime: 1 })],
      [remote('a', { authorityTime: 999 })],
      { resolve: () => 'local' },
    );
    expect(result.uploadRemotely.map((r) => r.id)).toEqual(['a']);
  });

  it('never both applies and uploads the same record', () => {
    const result = reconcile<Login>(
      [local('a', { dirty: true, authorityTime: 5000 }), local('b', { dirty: true })],
      [remote('a'), remote('c')],
    );
    const applied = new Set(result.applyLocally.map((r) => r.id));
    const uploaded = new Set(result.uploadRemotely.map((r) => r.id));
    for (const id of applied) expect(uploaded.has(id)).toBe(false);
    expect([...uploaded].sort()).toEqual(['a', 'b']);
    expect([...applied]).toEqual(['c']);
  });
});

describe('reconcile — deletions', () => {
  it('applies a remote tombstone for a record we hold', () => {
    const result = reconcile<Login>([local('a')], [remote('a', { deleted: true, data: null })]);
    expect(result.applyLocally[0]?.deleted).toBe(true);
  });

  it('ignores a remote tombstone for a record we never had', () => {
    const result = reconcile<Login>([], [remote('gone', { deleted: true, data: null })]);
    expect(result.applyLocally).toHaveLength(0);
    expect(result.ignoredTombstones).toEqual(['gone']);
  });

  it('uploads a local tombstone', () => {
    const result = reconcile<Login>(
      [local('a', { deleted: true, data: null, dirty: true, authorityTime: 9000 })],
      [],
    );
    expect(result.uploadRemotely[0]?.deleted).toBe(true);
  });

  it('does not resurrect a record deleted remotely after our last sync', () => {
    const result = reconcile<Login>(
      [local('a', { dirty: false, syncedAt: 10 })],
      [remote('a', { deleted: true, data: null, modified: 40 })],
    );
    expect(result.applyLocally[0]?.deleted).toBe(true);
    expect(result.uploadRemotely).toHaveLength(0);
  });
});

describe('expiredTombstones', () => {
  const now = 1_000_000_000;
  const month = 30 * 24 * 3600 * 1000;

  it('collects synced tombstones older than the retention window', () => {
    const records = [
      local('old', { deleted: true, data: null, dirty: false, authorityTime: now - month * 2 }),
      local('recent', { deleted: true, data: null, dirty: false, authorityTime: now - 1000 }),
      local('unsynced', { deleted: true, data: null, dirty: true, authorityTime: now - month * 2 }),
      local('alive'),
    ];
    expect(expiredTombstones(records, now, month)).toEqual(['old']);
  });

  it('returns nothing when there is nothing to purge', () => {
    expect(expiredTombstones([local('a')], now, month)).toEqual([]);
  });
});
