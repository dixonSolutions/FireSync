import { beforeEach, describe, expect, it } from 'vitest';
import { memoryStorageAreas } from '../src/common/storage.ts';
import type { MemoryArea } from '../src/common/storage.ts';
import {
  checkVerifier,
  deriveVaultKey,
  deriveVaultKeyBytes,
  makeVerifier,
  newKdfParams,
  seal,
  SLOT,
  unseal,
  VaultLockedError,
  WrongPassphraseError,
} from '../src/vault/crypto.ts';
import { STORAGE_KEY, VaultStore } from '../src/vault/store.ts';
import { MemoryKeyStore, generateDeviceKey } from '../src/vault/device-key.ts';

/** Low iteration count keeps the suite fast; production uses 600 000. */
const FAST_KDF = 120_000;
const PASSPHRASE = 'correct horse battery staple';

describe('vault crypto', () => {
  it('derives a non-extractable AES key and rejects a weak iteration count', async () => {
    const params = newKdfParams(FAST_KDF);
    const key = await deriveVaultKey(PASSPHRASE, params);
    expect(key.algorithm.name).toBe('AES-GCM');
    expect(key.extractable).toBe(false);
    await expect(
      deriveVaultKeyBytes(PASSPHRASE, { ...params, iterations: 1000 }),
    ).rejects.toThrow(/refusing to derive/);
  });

  it('salts each vault so identical passphrases give different keys', async () => {
    const a = await deriveVaultKeyBytes(PASSPHRASE, newKdfParams(FAST_KDF));
    const b = await deriveVaultKeyBytes(PASSPHRASE, newKdfParams(FAST_KDF));
    expect(a).not.toEqual(b);
  });

  it('normalises the passphrase so equivalent Unicode unlocks', async () => {
    const params = newKdfParams(FAST_KDF);
    const composed = await deriveVaultKey('café', params);
    const decomposed = await deriveVaultKey('café', params);
    expect(composed).toEqual(decomposed);
  });

  it('binds a sealed blob to its slot', async () => {
    const key = await deriveVaultKey(PASSPHRASE, newKdfParams(FAST_KDF));
    const blob = await seal(key, { secret: 1 }, SLOT.vault);
    await expect(unseal(key, blob, SLOT.tokens)).rejects.toThrow(WrongPassphraseError);
    await expect(unseal(key, blob, SLOT.vault)).resolves.toEqual({ secret: 1 });
  });

  it('verifies a passphrase without decrypting the whole vault', async () => {
    const params = newKdfParams(FAST_KDF);
    const right = await deriveVaultKey(PASSPHRASE, params);
    const wrong = await deriveVaultKey('not it', params);
    const verifier = await makeVerifier(right);

    expect(await checkVerifier(right, verifier)).toBe(true);
    expect(await checkVerifier(wrong, verifier)).toBe(false);
  });

  it('refuses a blob from a newer format version', async () => {
    const key = await deriveVaultKey(PASSPHRASE, newKdfParams(FAST_KDF));
    const blob = await seal(key, {}, SLOT.vault);
    await expect(unseal(key, { ...blob, v: 99 }, SLOT.vault)).rejects.toThrow(/newer than/);
  });
});

describe('VaultStore', () => {
  let areas: ReturnType<typeof memoryStorageAreas>;
  let vault: VaultStore;

  beforeEach(async () => {
    areas = memoryStorageAreas();
    vault = new VaultStore(areas, new MemoryKeyStore());
    await vault.create({ passphrase: PASSPHRASE, iterations: FAST_KDF });
  });

  it('starts unlocked after creation and reports its state', async () => {
    expect(await vault.isInitialized()).toBe(true);
    expect(await vault.isUnlocked()).toBe(true);
    expect(await vault.stats()).toEqual({ passwords: 0, addresses: 0, pendingUploads: 0 });
  });

  it('refuses to create a second vault over an existing one', async () => {
    await expect(vault.create({ passphrase: PASSPHRASE })).rejects.toThrow(/already exists/);
  });

  it('writes only ciphertext to local storage', async () => {
    await vault.addPassword({
      origin: 'https://example.com',
      username: 'ada',
      password: 'super-secret-value',
    });

    const onDisk = JSON.stringify((areas.local as MemoryArea).snapshot());
    expect(onDisk).not.toContain('super-secret-value');
    expect(onDisk).not.toContain('ada');
    expect(onDisk).toContain('A256GCM');
  });

  it('keeps the unlocked key only in session storage', async () => {
    const local = JSON.stringify((areas.local as MemoryArea).snapshot());
    expect(local).not.toContain('vaultKey');
    expect((areas.session as MemoryArea).snapshot()[STORAGE_KEY.unlocked]).toBeDefined();
  });

  it('locks and refuses reads until unlocked again', async () => {
    await vault.addPassword({ origin: 'https://a.test', username: 'u', password: 'p' });
    await vault.lock();

    expect(await vault.isUnlocked()).toBe(false);
    await expect(vault.listPasswords()).rejects.toThrow(VaultLockedError);

    await vault.unlock(PASSPHRASE);
    expect(await vault.listPasswords()).toHaveLength(1);
  });

  it('rejects the wrong passphrase', async () => {
    await vault.lock();
    await expect(vault.unlock('wrong passphrase entirely')).rejects.toThrow(WrongPassphraseError);
    expect(await vault.isUnlocked()).toBe(false);
  });

  it('re-encrypts everything when the passphrase changes', async () => {
    await vault.addPassword({ origin: 'https://a.test', username: 'u', password: 'p' });
    await vault.writeTokens({
      uid: 'uid',
      email: 'user@example.org',
      refreshToken: 'refresh-token-value',
      kSync: 'a2V5',
      kid: '1-abc',
      connectedAt: 1,
    });

    await vault.setProtection({ passphrase: 'a brand new passphrase' }, PASSPHRASE);
    await vault.lock();

    await expect(vault.unlock(PASSPHRASE)).rejects.toThrow(WrongPassphraseError);
    await vault.unlock('a brand new passphrase');

    expect(await vault.listPasswords()).toHaveLength(1);
    expect((await vault.readTokens())?.refreshToken).toBe('refresh-token-value');
  });

  it('reset removes every trace', async () => {
    await vault.addPassword({ origin: 'https://a.test', username: 'u', password: 'p' });
    await vault.reset();
    expect(await vault.isInitialized()).toBe(false);
    expect((areas.local as MemoryArea).snapshot()).toEqual({});
  });

  describe('passwords', () => {
    it('adds, reads, patches and deletes', async () => {
      const record = await vault.addPassword({
        origin: 'https://example.com',
        username: 'ada',
        password: 'hunter2',
      });

      expect(await vault.getPassword(record.id)).toMatchObject({ username: 'ada' });

      await vault.patchPassword(record.id, { username: 'ada.lovelace' });
      expect((await vault.getPassword(record.id))?.username).toBe('ada.lovelace');

      await vault.updatePassword(record.id, 'new-secret');
      expect((await vault.getPassword(record.id))?.password).toBe('new-secret');

      await vault.deletePassword(record.id);
      expect(await vault.getPassword(record.id)).toBeNull();
      expect(await vault.listPasswords()).toHaveLength(0);
    });

    it('leaves a tombstone behind for a deletion so it can sync', async () => {
      const record = await vault.addPassword({
        origin: 'https://example.com',
        username: 'ada',
        password: 'hunter2',
      });
      await vault.deletePassword(record.id);

      const records = await vault.localRecords('passwords');
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ id: record.id, deleted: true, dirty: true, data: null });
    });

    it('marks new records dirty and clears the flag once synced', async () => {
      const record = await vault.addPassword({
        origin: 'https://example.com',
        username: 'ada',
        password: 'hunter2',
      });
      expect((await vault.localRecords('passwords'))[0]?.dirty).toBe(true);
      expect(await vault.stats()).toMatchObject({ pendingUploads: 1 });

      await vault.markSynced('passwords', [record.id], 1234.5);
      const synced = (await vault.localRecords('passwords'))[0];
      expect(synced?.dirty).toBe(false);
      expect(synced?.syncedAt).toBe(1234.5);
    });

    it('finds matches for a page and ranks the most specific first', async () => {
      await vault.addPassword({ origin: 'https://example.com', username: 'broad', password: 'p' });
      await vault.addPassword({
        origin: 'https://login.example.com',
        username: 'specific',
        password: 'p',
      });
      await vault.addPassword({ origin: 'https://other.test', username: 'nope', password: 'p' });

      const matches = await vault.findPasswordsForUrl('https://login.example.com/signin');
      expect(matches.map((match) => match.record.username)).toEqual(['specific', 'broad']);
    });

    it('honours a stricter match strategy', async () => {
      await vault.addPassword({ origin: 'https://example.com', username: 'u', password: 'p' });
      const matches = await vault.findPasswordsForUrl('https://login.example.com/', {
        strategy: 'host',
      });
      expect(matches).toHaveLength(0);
    });

    it('touching a credential bumps usage but not the sync authority', async () => {
      const record = await vault.addPassword({
        origin: 'https://example.com',
        username: 'ada',
        password: 'hunter2',
      });
      const before = (await vault.localRecords('passwords'))[0]?.authorityTime;
      await vault.touchPassword(record.id);
      const after = (await vault.localRecords('passwords'))[0];

      expect(after?.data).toMatchObject({ timesUsed: 2 });
      expect(after?.authorityTime).toBe(before);
    });

    it('rejects updates to a record that does not exist', async () => {
      await expect(vault.updatePassword('nope', 'x')).rejects.toThrow(/no password with id/);
    });
  });

  describe('remote application', () => {
    it('applies remote records and purges tombstones', async () => {
      await vault.applyRemote('passwords', [
        {
          id: 'remote-1',
          data: {
            id: 'remote-1',
            hostname: 'https://remote.test',
            formSubmitURL: 'https://remote.test',
            httpRealm: null,
            username: 'from-firefox',
            password: 'p',
          },
          deleted: false,
          authorityTime: 100,
          syncedAt: 5,
          dirty: false,
        },
      ]);

      expect(await vault.listPasswords()).toHaveLength(1);
      await vault.purgeRecords('passwords', ['remote-1']);
      expect(await vault.listPasswords()).toHaveLength(0);
    });
  });

  describe('sync state', () => {
    it('round-trips encrypted', async () => {
      const state = await vault.readSyncState();
      state.lastSyncAt = 1234;
      state.collections['passwords'] = { lastModified: 99.5, syncId: 'abc' };
      await vault.writeSyncState(state);

      await vault.lock();
      await vault.unlock(PASSPHRASE);

      const reloaded = await vault.readSyncState();
      expect(reloaded.lastSyncAt).toBe(1234);
      expect(reloaded.collections['passwords']).toEqual({ lastModified: 99.5, syncId: 'abc' });
    });
  });
});

describe('device-key protection (the default)', () => {
  let areas: ReturnType<typeof memoryStorageAreas>;
  let keys: MemoryKeyStore;
  let vault: VaultStore;

  beforeEach(async () => {
    areas = memoryStorageAreas();
    keys = new MemoryKeyStore();
    vault = new VaultStore(areas, keys);
    await vault.create();
  });

  it('needs nothing from the user and is immediately usable', async () => {
    expect(await vault.protection()).toBe('device');
    expect(await vault.isInitialized()).toBe(true);
    expect(await vault.isUnlocked()).toBe(true);
    await expect(vault.listPasswords()).resolves.toEqual([]);
  });

  it('ensure() creates a vault silently and is idempotent', async () => {
    const fresh = new VaultStore(memoryStorageAreas(), new MemoryKeyStore());
    expect(await fresh.isInitialized()).toBe(false);
    await fresh.ensure();
    await fresh.ensure();
    expect(await fresh.isInitialized()).toBe(true);
    expect(await fresh.protection()).toBe('device');
  });

  it('generates a key that can never be exported', async () => {
    const key = await generateDeviceKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('never writes key material to storage', async () => {
    await vault.addPassword({
      origin: 'https://example.com',
      username: 'ada',
      password: 'super-secret-value',
    });

    const local = JSON.stringify((areas.local as MemoryArea).snapshot());
    expect(local).not.toContain('super-secret-value');
    expect(local).not.toContain('ada');
    expect(local).toContain('A256GCM');

    // The key lives in the key store, not in either storage area.
    expect(JSON.stringify((areas.session as MemoryArea).snapshot())).toBe('{}');
    expect(local).not.toContain('vaultKey');
  });

  it('is readable again after a service-worker restart', async () => {
    await vault.addPassword({ origin: 'https://a.test', username: 'u', password: 'p' });

    // A new VaultStore over the same storage and the same key store is exactly
    // what a woken service worker sees.
    const restarted = new VaultStore(areas, keys);
    expect(await restarted.isUnlocked()).toBe(true);
    expect(await restarted.listPasswords()).toHaveLength(1);
  });

  it('is unreadable to a browser profile that does not have the key', async () => {
    await vault.addPassword({ origin: 'https://a.test', username: 'u', password: 'p' });
    const stranger = new VaultStore(areas, new MemoryKeyStore());
    await expect(stranger.listPasswords()).rejects.toThrow();
  });

  it('does not pretend to lock', async () => {
    await vault.lock();
    expect(await vault.isUnlocked()).toBe(true);
    await expect(vault.listPasswords()).resolves.toEqual([]);
  });

  it('upgrades to a passphrase and back without losing anything', async () => {
    await vault.addPassword({ origin: 'https://a.test', username: 'ada', password: 'p' });
    await vault.writeTokens({
      uid: 'uid',
      email: 'ada@example.org',
      refreshToken: 'refresh-token-value',
      kSync: 'a2V5',
      kid: '1-abc',
      connectedAt: 1,
    });

    await vault.setProtection({ passphrase: 'a chosen passphrase', iterations: FAST_KDF });
    expect(await vault.protection()).toBe('passphrase');
    expect(await vault.listPasswords()).toHaveLength(1);

    // Now it really does lock.
    await vault.lock();
    expect(await vault.isUnlocked()).toBe(false);
    await expect(vault.listPasswords()).rejects.toThrow(VaultLockedError);

    await vault.unlock('a chosen passphrase');
    expect((await vault.readTokens())?.refreshToken).toBe('refresh-token-value');

    await vault.setProtection({ passphrase: null }, 'a chosen passphrase');
    expect(await vault.protection()).toBe('device');
    expect(await vault.isUnlocked()).toBe(true);
    expect(await vault.listPasswords()).toHaveLength(1);
  });

  it('requires the current passphrase to leave passphrase mode', async () => {
    await vault.setProtection({ passphrase: 'a chosen passphrase', iterations: FAST_KDF });
    await expect(vault.setProtection({ passphrase: null })).rejects.toThrow(/current passphrase/);
  });

  it('reset discards the device key too', async () => {
    await vault.addPassword({ origin: 'https://a.test', username: 'u', password: 'p' });
    await vault.reset();

    expect(await vault.isInitialized()).toBe(false);
    expect((areas.local as MemoryArea).snapshot()).toEqual({});
    // A new vault gets a new key, so the old ciphertext stays unreadable.
    await vault.create();
    expect(await vault.listPasswords()).toEqual([]);
  });
});
