import { describe, expect, it } from 'vitest';
import {
  engineIsEnabled,
  engineWasReset,
  parseMetaGlobal,
  STORAGE_VERSION,
  UnsupportedStorageVersionError,
} from '../src/sync15/meta.ts';

const META = {
  storageVersion: 5,
  syncID: 'account-sync-id',
  engines: {
    passwords: { version: 1, syncID: 'p1' },
    addresses: { version: 1, syncID: 'a1' },
  },
  declined: ['creditcards'],
};

describe('parseMetaGlobal', () => {
  it('accepts storage version 5', () => {
    expect(parseMetaGlobal(META)).toMatchObject({ storageVersion: STORAGE_VERSION });
  });

  it('refuses any other storage version, loudly', () => {
    expect(() => parseMetaGlobal({ ...META, storageVersion: 6 })).toThrow(
      UnsupportedStorageVersionError,
    );
    expect(() => parseMetaGlobal({ ...META, storageVersion: 4 })).toThrow(/version 4/);
  });

  it('rejects a record with no storageVersion at all', () => {
    expect(() => parseMetaGlobal({ syncID: 'x' })).toThrow(/no storageVersion/);
    expect(() => parseMetaGlobal(null)).toThrow(/not an object/);
  });

  it('tolerates a missing engines map', () => {
    expect(parseMetaGlobal({ storageVersion: 5 }).engines).toEqual({});
  });
});

describe('engineWasReset', () => {
  const meta = parseMetaGlobal(META);

  it('is true when the remote sync id changed', () => {
    expect(engineWasReset(meta, 'passwords', 'old-id')).toBe(true);
  });

  it('is false when the ids agree', () => {
    expect(engineWasReset(meta, 'passwords', 'p1')).toBe(false);
  });

  it('is false on a first sync, when we have no cached id', () => {
    expect(engineWasReset(meta, 'passwords', null)).toBe(false);
  });

  it('is false for an engine the server does not declare', () => {
    expect(engineWasReset(meta, 'bookmarks', 'anything')).toBe(false);
  });
});

describe('engineIsEnabled', () => {
  const meta = parseMetaGlobal(META);

  it('is true for a declared engine', () => {
    expect(engineIsEnabled(meta, 'passwords')).toBe(true);
  });

  it('is false for a declined engine', () => {
    expect(engineIsEnabled(meta, 'creditcards')).toBe(false);
  });

  it('is false for an engine that is neither declared nor declined', () => {
    expect(engineIsEnabled(meta, 'tabs')).toBe(false);
  });
});
