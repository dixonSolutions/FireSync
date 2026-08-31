/**
 * The connection test exists because every failure this session looked the same
 * from outside: one sentence, naming no stage. These assert that each hop is
 * reported separately, and that the walk stops at the first thing that breaks
 * rather than reporting noise from every stage after it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { memoryStorageAreas } from '../src/common/storage.ts';
import { MemoryKeyStore } from '../src/vault/device-key.ts';
import { FxAClient } from '../src/fxa/client.ts';
import { VaultStore } from '../src/vault/store.ts';
import { runAuthCheck } from '../src/sync15/authcheck.ts';
import type { AuthCheckStage } from '../src/sync15/authcheck.ts';
import {
  AUTH_SERVER,
  FakeSyncServer,
  kSyncFor,
  randomKeyBundle,
  TOKEN_SERVER,
} from './helpers/fake-sync-server.ts';

async function harness() {
  const syncKeyBundle = randomKeyBundle();
  const server = new FakeSyncServer({ syncKeyBundle });
  const vault = new VaultStore(memoryStorageAreas(), new MemoryKeyStore());
  await vault.create();
  await vault.writeTokens({
    uid: 'uid-42',
    email: 'ada@example.org',
    refreshToken: 'refresh-token',
    clientId: '3c49430b43dfba77',
    kSync: kSyncFor(syncKeyBundle),
    kid: '1510628805-Zm9vYmFyZm9vYmFyZm8',
    connectedAt: Date.now(),
  });
  const deps = {
    vault,
    client: new FxAClient({ authServerUrl: AUTH_SERVER, fetchImpl: server.fetch }),
    tokenServerUrl: TOKEN_SERVER,
    fetchImpl: server.fetch,
    now: () => 1000,
  };
  return { server, vault, deps };
}

const stages = (report: { steps: { stage: AuthCheckStage }[] }): AuthCheckStage[] =>
  report.steps.map((step) => step.stage);

describe('runAuthCheck', () => {
  let context: Awaited<ReturnType<typeof harness>>;

  beforeEach(async () => {
    context = await harness();
  });

  it('walks every hop when the connection is healthy', async () => {
    await context.server.seed('passwords', { id: 'x' });

    const report = await runAuthCheck(context.deps);

    expect(report.ok).toBe(true);
    expect(stages(report)).toEqual([
      'account',
      'refresh-token',
      'token-server',
      'storage-credentials',
      'sync-data',
    ]);
    expect(report.steps.every((step) => step.ok)).toBe(true);
  });

  it('stops at the first broken hop rather than reporting noise after it', async () => {
    await context.vault.clearTokens();

    const report = await runAuthCheck(context.deps);

    expect(report.ok).toBe(false);
    expect(stages(report)).toEqual(['account']);
    expect(report.steps[0]?.detail).toMatch(/sign in/);
  });

  it('separates an empty account from a broken one', async () => {
    // Credentials work; the account simply has nothing in it.
    const report = await runAuthCheck(context.deps);

    expect(report.ok).toBe(false);
    expect(stages(report)).toContain('storage-credentials');
    const storage = report.steps.find((step) => step.stage === 'storage-credentials');
    const data = report.steps.find((step) => step.stage === 'sync-data');
    expect(storage?.ok).toBe(true);
    expect(data?.ok).toBe(false);
    expect(data?.detail).toMatch(/never synced/);
  });

  it('names the OAuth client the token belongs to, which is where one bug hid', async () => {
    await context.server.seed('passwords', { id: 'x' });

    const report = await runAuthCheck(context.deps);

    expect(report.steps[0]?.detail).toContain('3c49430b43dfba77');
  });
});
