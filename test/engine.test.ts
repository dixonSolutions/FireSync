/**
 * End-to-end sync tests: a real `SyncEngine` and a real `VaultStore` driven
 * against the in-memory Sync server in `test/helpers/fake-sync-server.ts`.
 *
 * These are the tests that would have caught every protocol bug worth having:
 * key derivation wired to the wrong bundle, high-water marks that skip records,
 * a 412 that clobbers, an engine reset that silently loses data.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { memoryStorageAreas } from '../src/common/storage.ts';
import { MemoryKeyStore } from '../src/vault/device-key.ts';
import { FxAClient } from '../src/fxa/client.ts';
import { SyncEngine } from '../src/sync15/engine.ts';
import type { PasswordRecord } from '../src/sync15/engines/passwords.ts';
import { VaultStore } from '../src/vault/store.ts';
import {
  AUTH_SERVER,
  FakeSyncServer,
  kSyncFor,
  randomKeyBundle,
  TOKEN_SERVER,
} from './helpers/fake-sync-server.ts';


function firefoxLogin(overrides: Partial<PasswordRecord> = {}): PasswordRecord {
  return {
    id: 'from-firefox-01',
    hostname: 'https://firefox.example',
    formSubmitURL: 'https://firefox.example',
    httpRealm: null,
    username: 'ada',
    password: 'set-in-firefox',
    usernameField: 'email',
    passwordField: 'pass',
    timeCreated: 1_600_000_000_000,
    timePasswordChanged: 1_600_000_000_000,
    timeLastUsed: 1_600_000_000_000,
    timesUsed: 1,
    ...overrides,
  };
}

async function harness() {
  const syncKeyBundle = randomKeyBundle();
  const server = new FakeSyncServer({ syncKeyBundle });
  const areas = memoryStorageAreas();
  const vault = new VaultStore(areas, new MemoryKeyStore());

  await vault.create();
  await vault.writeTokens({
    uid: 'uid-42',
    email: 'ada@example.org',
    refreshToken: 'refresh-token',
    kSync: kSyncFor(syncKeyBundle),
    kid: '1510628805-Zm9vYmFyZm9vYmFyZm8',
    connectedAt: Date.now(),
  });

  const engine = new SyncEngine({
    vault,
    client: new FxAClient({ authServerUrl: AUTH_SERVER, fetchImpl: server.fetch }),
    tokenServerUrl: TOKEN_SERVER,
    fetchImpl: server.fetch,
    collections: ['passwords'],
  });

  // meta/global and crypto/keys must exist before the first read.
  await server.seed('crypto', { id: 'placeholder' });
  server.collections.get('crypto')?.delete('placeholder');

  return { server, vault, engine };
}

describe('SyncEngine', () => {
  let context: Awaited<ReturnType<typeof harness>>;

  beforeEach(async () => {
    context = await harness();
  });

  /**
   * `meta/global` is written by the first browser that turns Sync on. Its
   * absence is a fact about the account, not a transport failure, and saying
   * "404" sends people hunting for a bug in FireSync instead of turning Sync on.
   */
  it('says the account has never synced when meta/global is missing', async () => {
    context.server.removeMetaGlobal();

    const result = await context.engine.sync();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/never synced/);
    expect(result.error).toMatch(/Turn on Sync in Firefox/);
    expect(result.error).not.toMatch(/404/);
  });

  it('pulls logins that only exist in Firefox', async () => {
    await context.server.seed('passwords', firefoxLogin());

    const result = await context.engine.sync();

    expect(result.ok).toBe(true);
    expect(result.engines[0]).toMatchObject({ collection: 'passwords', pulled: 1, pushed: 0 });

    const local = await context.vault.listPasswords();
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({ username: 'ada', password: 'set-in-firefox' });
  });

  it('pushes logins saved in Chrome', async () => {
    await context.vault.addPassword({
      origin: 'https://chrome.example',
      username: 'grace',
      password: 'saved-in-chrome',
    });

    const result = await context.engine.sync();

    expect(result.engines[0]).toMatchObject({ pushed: 1 });
    const onServer = await context.server.decrypted<PasswordRecord>('passwords');
    expect(onServer).toHaveLength(1);
    expect(onServer[0]).toMatchObject({ username: 'grace', password: 'saved-in-chrome' });
    // Firefox requires exactly one of these to be set.
    expect(onServer[0]?.formSubmitURL).toBe('https://chrome.example');
    expect(onServer[0]?.httpRealm).toBeNull();
  });

  it('clears the dirty flag once the server accepts a record', async () => {
    await context.vault.addPassword({
      origin: 'https://chrome.example',
      username: 'grace',
      password: 'p',
    });
    await context.engine.sync();

    expect((await context.vault.stats()).pendingUploads).toBe(0);
  });

  it('is idempotent — a second sync does nothing', async () => {
    await context.server.seed('passwords', firefoxLogin());
    await context.vault.addPassword({
      origin: 'https://chrome.example',
      username: 'grace',
      password: 'p',
    });
    await context.engine.sync();

    const second = await context.engine.sync();
    expect(second.engines[0]).toMatchObject({ pulled: 0, pushed: 0, conflicts: 0 });
  });

  it('only fetches records newer than the high-water mark', async () => {
    await context.server.seed('passwords', firefoxLogin({ id: 'first' }));
    await context.engine.sync();

    await context.server.seed('passwords', firefoxLogin({ id: 'second', username: 'grace' }));
    const second = await context.engine.sync();

    expect(second.engines[0]?.pulled).toBe(1);
    expect(await context.vault.listPasswords()).toHaveLength(2);

    const lastRead = context.server.requests
      .filter((request) => request.url.includes('/storage/passwords?'))
      .at(-1);
    expect(lastRead?.url).toContain('newer=');
  });

  it('propagates a deletion made in Chrome as a tombstone', async () => {
    await context.server.seed('passwords', firefoxLogin());
    await context.engine.sync();

    const [record] = await context.vault.listPasswords();
    await context.vault.deletePassword(record!.id);
    await context.engine.sync();

    const onServer = await context.server.decrypted<PasswordRecord>('passwords');
    expect(onServer[0]).toMatchObject({ id: record!.id, deleted: true });
  });

  it('applies a deletion made in Firefox', async () => {
    await context.server.seed('passwords', firefoxLogin());
    await context.engine.sync();
    expect(await context.vault.listPasswords()).toHaveLength(1);

    await context.server.seed('passwords', { id: 'from-firefox-01', deleted: true });
    await context.engine.sync();

    expect(await context.vault.listPasswords()).toHaveLength(0);
  });

  it('resolves a two-sided edit in favour of the newer timePasswordChanged', async () => {
    await context.server.seed('passwords', firefoxLogin());
    await context.engine.sync();

    // Firefox changes it at T+1000; Chrome changed it at T+2000.
    const [record] = await context.vault.listPasswords();
    await context.vault.updatePassword(record!.id, 'changed-in-chrome');
    await context.server.seed(
      'passwords',
      firefoxLogin({ password: 'changed-in-firefox', timePasswordChanged: 1_600_000_001_000 }),
    );

    const result = await context.engine.sync();

    expect(result.engines[0]?.conflicts).toBe(1);
    const local = await context.vault.listPasswords();
    expect(local[0]?.password).toBe('changed-in-chrome');
    const onServer = await context.server.decrypted<PasswordRecord>('passwords');
    expect(onServer[0]?.password).toBe('changed-in-chrome');
  });

  it('lets Firefox win when its edit is newer', async () => {
    await context.server.seed('passwords', firefoxLogin());
    await context.engine.sync();

    const [record] = await context.vault.listPasswords();
    await context.vault.updatePassword(record!.id, 'changed-in-chrome');
    await context.server.seed(
      'passwords',
      firefoxLogin({ password: 'changed-in-firefox', timePasswordChanged: Date.now() + 60_000 }),
    );

    await context.engine.sync();

    expect((await context.vault.listPasswords())[0]?.password).toBe('changed-in-firefox');
  });

  it('skips records it cannot decrypt instead of failing the whole engine', async () => {
    await context.server.seed('passwords', firefoxLogin());
    context.server.collections.get('passwords')?.set('corrupt', {
      id: 'corrupt',
      modified: context.server.now(),
      payload: JSON.stringify({ ciphertext: 'AAAA', IV: 'AAAA', hmac: 'deadbeef' }),
    });

    const result = await context.engine.sync();

    expect(result.ok).toBe(true);
    expect(result.engines[0]).toMatchObject({ pulled: 1, skipped: 1 });
  });

  it('does not clobber on a 412 and re-reconciles next time', async () => {
    await context.vault.addPassword({
      origin: 'https://chrome.example',
      username: 'grace',
      password: 'p',
    });
    await context.engine.sync();

    await context.vault.addPassword({
      origin: 'https://chrome2.example',
      username: 'hopper',
      password: 'p',
    });
    context.server.failNextWriteWith412 = true;

    const conflicted = await context.engine.sync();
    expect(conflicted.engines[0]?.error).toMatch(/re-reconcile/);
    expect((await context.vault.stats()).pendingUploads).toBe(1);

    const recovered = await context.engine.sync();
    expect(recovered.engines[0]?.pushed).toBe(1);
    expect((await context.vault.stats()).pendingUploads).toBe(0);
  });

  it('records a server backoff request', async () => {
    await context.server.seed('passwords', firefoxLogin());
    context.server.backoffSeconds = 60;

    const result = await context.engine.sync();
    expect(result.backoffUntil).toBeGreaterThan(Date.now());
  });

  it('refuses an account using an unsupported storage version', async () => {
    context.server.setMetaGlobal({ storageVersion: 6 });
    const result = await context.engine.sync();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/storage version 6/);
  });

  it('re-reads everything when Firefox resets the passwords engine', async () => {
    await context.server.seed('passwords', firefoxLogin());
    await context.engine.sync();
    await context.vault.purgeRecords('passwords', ['from-firefox-01']);

    context.server.setMetaGlobal({
      engines: {
        passwords: { version: 1, syncID: 'a-brand-new-sync-id' },
        addresses: { version: 1, syncID: 'addresses-sync-id' },
      },
    });

    const result = await context.engine.sync();
    expect(result.engines[0]?.pulled).toBe(1);
    expect(await context.vault.listPasswords()).toHaveLength(1);
  });

  it('paginates through a large collection', async () => {
    for (let i = 0; i < 5; i++) {
      await context.server.seed(
        'passwords',
        firefoxLogin({ id: `login-${i}`, username: `user-${i}` }),
      );
    }
    // The engine asks for 200 per page by default; force pagination.
    const engine = new SyncEngine({
      vault: context.vault,
      client: new FxAClient({ authServerUrl: AUTH_SERVER, fetchImpl: context.server.fetch }),
      tokenServerUrl: TOKEN_SERVER,
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        if (url.pathname.endsWith('/storage/passwords') && (init?.method ?? 'GET') === 'GET') {
          url.searchParams.set('limit', '2');
          return context.server.fetch(url.toString(), init);
        }
        return context.server.fetch(input, init);
      },
      collections: ['passwords'],
    });

    const result = await engine.sync();
    expect(result.engines[0]?.pulled).toBe(5);
    expect(await context.vault.listPasswords()).toHaveLength(5);
  });

  it('splits an upload into server-sized batches', async () => {
    for (let i = 0; i < 5; i++) {
      await context.vault.addPassword({
        origin: `https://site-${i}.example`,
        username: `u${i}`,
        password: 'p',
      });
    }
    const result = await context.engine.sync();

    expect(result.engines[0]?.pushed).toBe(5);
    // max_post_records is 2 in the fake server, so 5 records take 3 POSTs.
    const posts = context.server.requests.filter(
      (request) => request.method === 'POST' && request.url.includes('/storage/passwords'),
    );
    expect(posts).toHaveLength(3);
    expect(posts[0]?.url).toContain('batch=true');
    expect(posts.at(-1)?.url).toContain('commit=true');
  });

  it('reports a failure when the account is not connected', async () => {
    await context.vault.clearTokens();
    const result = await context.engine.sync();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no Mozilla account/);
  });

  it('coalesces concurrent sync calls', async () => {
    await context.server.seed('passwords', firefoxLogin());
    const [a, b] = await Promise.all([context.engine.sync(), context.engine.sync()]);
    expect(a).toBe(b);
  });

  it('stores the last sync time and clears the error on success', async () => {
    await context.engine.sync();
    const state = await context.vault.readSyncState();
    expect(state.lastSyncAt).toBeGreaterThan(0);
    expect(state.lastSyncError).toBeNull();
  });
});
