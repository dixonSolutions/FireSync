/**
 * Sign-in must survive the service worker being killed mid-flow.
 *
 * That is not a hypothetical: the first implementation held the PKCE verifier,
 * the ephemeral key and the `tabs.onUpdated` listener in a closure, and Chrome
 * reaped the worker while the user was typing a two-factor code. The redirect
 * then arrived with nothing listening. Every test here that constructs a
 * *second* coordinator is reproducing that.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryArea } from '../src/common/storage.ts';
import { SIGNIN_KEY, SignInCoordinator, redact } from '../src/background/signin.ts';
import type { HostedSignIn } from '../src/fxa/hosted.ts';
import type { AccountTokens } from '../src/vault/types.ts';

const REDIRECT = 'https://accounts.firefox.com/oauth/success/3c49430b43dfba77';
const AUTHORIZE = 'https://accounts.firefox.com/authorization?client_id=x&state=st';

const ACCOUNT: AccountTokens = {
  uid: 'uid-1',
  email: 'ada@example.org',
  refreshToken: 'refresh',
  kSync: 'a2V5',
  kid: '1-abc',
  connectedAt: 1,
};

/** A stand-in for HostedSignIn with just the three methods the coordinator uses. */
function fakeFlow(overrides: Partial<Record<'complete', () => Promise<AccountTokens>>> = {}) {
  return {
    start: async () => ({
      authorizationUrl: AUTHORIZE,
      redirectUri: REDIRECT,
      state: 'st',
      codeVerifier: 'verifier',
      privateKeyJwk: { kty: 'EC', crv: 'P-256', d: 'secret', x: 'x', y: 'y' },
      startedAt: 1000,
    }),
    matches: (url: string, pending: { state: string }) => {
      if (!url.startsWith(REDIRECT)) return false;
      const parsed = new URL(url);
      if (parsed.searchParams.get('error')) throw new Error('authorization failed: access_denied');
      if (parsed.searchParams.get('state') !== pending.state) {
        throw new Error('authorization state mismatch — possible CSRF, aborting');
      }
      return parsed.searchParams.has('code');
    },
    complete: overrides.complete ?? (async () => ACCOUNT),
  } as unknown as HostedSignIn;
}

describe('SignInCoordinator', () => {
  let session: MemoryArea;
  let local: MemoryArea;
  let saved: AccountTokens[];
  let created: string[];
  let removed: number[];
  let clock: number;

  const tabs = {
    create: async (url: string) => {
      created.push(url);
      return 42;
    },
    remove: async (tabId: number) => {
      removed.push(tabId);
    },
  };

  function make(flow = fakeFlow()) {
    return new SignInCoordinator({
      session,
      local,
      saveAccount: async (a) => {
        saved.push(a);
      },
      flow,
      tabs,
      now: () => clock,
    });
  }

  beforeEach(() => {
    session = new MemoryArea();
    local = new MemoryArea();
    saved = [];
    created = [];
    removed = [];
    clock = 1000;
  });

  it('opens the authorization tab and returns immediately', async () => {
    const result = await make().begin();
    expect(result).toEqual({ step: 'started' });
    expect(created).toEqual([AUTHORIZE]);
    expect(await session.get(SIGNIN_KEY.pending)).toMatchObject({ tabId: 42, state: 'st' });
  });

  it('persists the flow to session storage, not to memory', async () => {
    await make().begin();
    const pending = await session.get<Record<string, unknown>>(SIGNIN_KEY.pending);
    // These are precisely the values a dead worker would have taken with it.
    expect(pending).toMatchObject({ codeVerifier: 'verifier', state: 'st' });
    expect(pending?.['privateKeyJwk']).toBeTruthy();
  });

  it('COMPLETES AFTER THE WORKER RESTARTS — the regression', async () => {
    await make().begin();

    // Everything in memory is gone; only chrome.storage.session survived.
    const revived = make();
    await revived.onNavigation(42, `${REDIRECT}?code=abc&state=st`);

    expect(saved).toEqual([ACCOUNT]);
    expect(removed).toEqual([42]);
    const progress = await revived.progress();
    expect(progress.active).toBe(false);
    expect(progress.lastResult).toMatchObject({ status: 'complete', email: 'ada@example.org' });
  });

  it('survives several restarts across a long sign-in', async () => {
    await make().begin();
    await make().onNavigation(42, 'https://accounts.firefox.com/signin');
    await make().onNavigation(42, 'https://accounts.firefox.com/signin_totp_code');
    clock += 8 * 60_000; // the user went to find their phone
    await make().onNavigation(42, `${REDIRECT}?code=abc&state=st`);

    expect(saved).toEqual([ACCOUNT]);
  });

  it('ignores unrelated navigations in other tabs', async () => {
    const coordinator = make();
    await coordinator.begin();
    await coordinator.onNavigation(99, 'https://example.com/somewhere');
    await coordinator.onNavigation(99, 'https://accounts.firefox.com/settings');
    expect(saved).toEqual([]);
    expect((await coordinator.progress()).active).toBe(true);
  });

  it('accepts the redirect from another tab, because the state proves it is ours', async () => {
    // The relay content script reports from whatever tab it runs in, and a user
    // may move the sign-in to another window. Binding strictly to the tab id we
    // opened would drop a legitimate redirect. It stays safe because
    // `parseRedirect` has already required our exact origin, path and state, and
    // the state is 128 bits we generated and only told Mozilla.
    const coordinator = make();
    await coordinator.begin();
    await coordinator.onNavigation(99, `${REDIRECT}?code=abc&state=st`);
    expect(saved).toEqual([ACCOUNT]);
  });

  it('still refuses a redirect carrying the wrong state, whatever tab it is in', async () => {
    const coordinator = make();
    await coordinator.begin();
    await coordinator.onNavigation(99, `${REDIRECT}?code=abc&state=FORGED`);
    expect(saved).toEqual([]);
  });

  it('does nothing at all when no sign-in is pending', async () => {
    const coordinator = make();
    await coordinator.onNavigation(42, `${REDIRECT}?code=abc&state=st`);
    expect(saved).toEqual([]);
    expect(await coordinator.progress()).toMatchObject({ active: false, lastResult: null });
  });

  it('records where the sign-in got to, without leaking the code', async () => {
    const coordinator = make();
    await coordinator.begin();
    await coordinator.onNavigation(42, 'https://accounts.firefox.com/signin?email=ada%40example.org');
    await coordinator.onNavigation(42, 'https://accounts.firefox.com/signin_totp_code');

    const trail = (await coordinator.progress()).trail;
    expect(trail).toEqual([
      'https://accounts.firefox.com/signin',
      'https://accounts.firefox.com/signin_totp_code',
    ]);
    expect(JSON.stringify(trail)).not.toContain('ada%40example.org');

    await coordinator.onNavigation(42, `${REDIRECT}?code=SECRET-CODE&state=st`);
    const result = (await coordinator.progress()).lastResult;
    expect(JSON.stringify(result)).not.toContain('SECRET-CODE');
  });

  it('does not record the same page twice in a row', async () => {
    const coordinator = make();
    await coordinator.begin();
    for (let i = 0; i < 4; i++) {
      await coordinator.onNavigation(42, 'https://accounts.firefox.com/signin');
    }
    expect((await coordinator.progress()).trail).toEqual(['https://accounts.firefox.com/signin']);
  });

  it('reports a state mismatch as an error instead of proceeding', async () => {
    const coordinator = make();
    await coordinator.begin();
    await coordinator.onNavigation(42, `${REDIRECT}?code=abc&state=WRONG`);

    expect(saved).toEqual([]);
    expect((await coordinator.progress()).lastResult).toMatchObject({
      status: 'error',
      error: expect.stringContaining('state mismatch'),
    });
  });

  it('reports an access-denied redirect', async () => {
    const coordinator = make();
    await coordinator.begin();
    await coordinator.onNavigation(42, `${REDIRECT}?error=access_denied`);
    expect((await coordinator.progress()).lastResult).toMatchObject({
      status: 'error',
      error: expect.stringContaining('access_denied'),
    });
  });

  it('reports a failed token exchange with its reason', async () => {
    const flow = fakeFlow({
      complete: async () => {
        throw new Error('Mozilla did not return the sync key.');
      },
    });
    const coordinator = make(flow);
    await coordinator.begin();
    await coordinator.onNavigation(42, `${REDIRECT}?code=abc&state=st`);

    expect(saved).toEqual([]);
    expect((await coordinator.progress()).lastResult).toMatchObject({
      status: 'error',
      error: expect.stringContaining('did not return the sync key'),
    });
  });

  it('treats a closed tab as cancellation', async () => {
    const coordinator = make();
    await coordinator.begin();
    await coordinator.onTabClosed(42);

    expect((await coordinator.progress()).lastResult).toMatchObject({ status: 'cancelled' });
    expect((await coordinator.progress()).active).toBe(false);
  });

  it('ignores an unrelated tab closing', async () => {
    const coordinator = make();
    await coordinator.begin();
    await coordinator.onTabClosed(7);
    expect((await coordinator.progress()).active).toBe(true);
  });

  it('abandons a flow the user walked away from', async () => {
    const coordinator = make();
    await coordinator.begin();
    clock += 25 * 60_000;
    await coordinator.onNavigation(42, `${REDIRECT}?code=abc&state=st`);

    expect(saved).toEqual([]);
    expect((await coordinator.progress()).lastResult).toMatchObject({
      status: 'error',
      error: expect.stringContaining('took too long'),
    });
  });

  it('clears a previous result when a new sign-in starts', async () => {
    const coordinator = make();
    await coordinator.begin();
    await coordinator.onTabClosed(42);
    expect((await coordinator.progress()).lastResult?.status).toBe('cancelled');

    await coordinator.begin();
    expect((await coordinator.progress()).lastResult).toBeNull();
    expect((await coordinator.progress()).active).toBe(true);
  });

  it('cancel() ends a pending flow', async () => {
    const coordinator = make();
    await coordinator.begin();
    await coordinator.cancel();
    expect((await coordinator.progress()).active).toBe(false);
  });

  it('ignores a navigation with no URL', async () => {
    const coordinator = make();
    await coordinator.begin();
    await coordinator.onNavigation(42, undefined);
    expect((await coordinator.progress()).active).toBe(true);
  });
});

describe('redact', () => {
  it('keeps origin and path, drops everything that could carry a secret', () => {
    expect(redact(`${REDIRECT}?code=SECRET&state=st#x`)).toBe(REDIRECT);
    expect(redact('https://a.test/b/c?token=x')).toBe('https://a.test/b/c');
  });

  it('does not throw on rubbish', () => {
    expect(redact('not a url')).toBe('(unparseable)');
  });
});
