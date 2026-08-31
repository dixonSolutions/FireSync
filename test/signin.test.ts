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
import { SIGNIN_KEY, SIGNIN_MAX_AGE_MS, SignInCoordinator, redact } from '../src/background/signin.ts';
import type { HostedSignIn } from '../src/fxa/hosted.ts';
import { NoSyncKeyError } from '../src/fxa/errors.ts';
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
    clock += SIGNIN_MAX_AGE_MS + 5 * 60_000;
    // Somewhere else entirely. This is what walking away looks like; the
    // redirect URL is what finishing looks like, and the two must not be
    // treated the same however long they took.
    await coordinator.onNavigation(42, 'https://example.test/read-the-news');

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

  it('stamps every result with the build that produced it', async () => {
    const coordinator = new SignInCoordinator({
      session,
      local,
      saveAccount: async (a) => {
        saved.push(a);
      },
      flow: fakeFlow(),
      tabs,
      now: () => clock,
      version: '9.9.9',
    });
    await coordinator.begin();
    await coordinator.onNavigation(42, `${REDIRECT}?code=abc&state=st`);

    expect((await coordinator.progress()).lastResult).toMatchObject({
      status: 'complete',
      version: '9.9.9',
    });
  });

  it('marks a keyless result so the UI can offer the password flow', async () => {
    const flow = fakeFlow({
      complete: async () => {
        throw new NoSyncKeyError('Mozilla granted the oldsync scope but returned no sync key', true);
      },
    });
    const coordinator = make(flow);
    await coordinator.begin();
    await coordinator.onNavigation(42, `${REDIRECT}?code=abc&state=st`);

    const { lastResult } = await coordinator.progress();
    expect(lastResult).toMatchObject({ status: 'error', reason: 'no-sync-key' });
  });

  it('leaves reason unset for failures the UI cannot act on', async () => {
    const flow = fakeFlow({
      complete: async () => {
        throw new Error('Unknown authorization code');
      },
    });
    const coordinator = make(flow);
    await coordinator.begin();
    await coordinator.onNavigation(42, `${REDIRECT}?code=abc&state=st`);

    const { lastResult } = await coordinator.progress();
    expect(lastResult?.status).toBe('error');
    expect(lastResult?.reason).toBeUndefined();
  });

  /**
   * The age cap exists to reap a flow the user walked away from. It must never
   * be the thing that rejects a sign-in that worked.
   */
  describe('a late redirect is still a redirect', () => {
    it('redeems a code that arrives after the flow has aged out', async () => {
      const coordinator = make();
      await coordinator.begin();

      // Long past the cap: the network was down for most of it.
      clock += SIGNIN_MAX_AGE_MS + 8 * 60_000;
      await coordinator.onNavigation(42, `${REDIRECT}?code=abc&state=st`);

      expect(saved).toEqual([ACCOUNT]);
      const { lastResult } = await coordinator.progress();
      expect(lastResult).toMatchObject({ status: 'complete', email: ACCOUNT.email });
    });

    it('does not age out a flow that is still within the cap', async () => {
      const coordinator = make();
      await coordinator.begin();

      clock += SIGNIN_MAX_AGE_MS - 1;
      await coordinator.onNavigation(42, 'https://accounts.firefox.com/signin_totp_code');

      expect((await coordinator.progress()).active).toBe(true);
    });
  });

  /**
   * The redirect is detected three ways on purpose — `tabs.onUpdated`,
   * `webNavigation.onCommitted` and the relay content script — because any one
   * of them can miss it. But an authorization code is single-use, so all three
   * firing must still produce exactly one redemption.
   *
   * In the field this failed exactly as you would predict: three concurrent
   * exchanges, one winner, and two `Unknown authorization code` errors that
   * then overwrote the winner's result. The user signed in and the extension
   * still said "Not signed in".
   */
  describe('redundant detection, single redemption', () => {
    function countingFlow() {
      let calls = 0;
      const flow = fakeFlow({
        complete: async () => {
          calls += 1;
          // The real exchange is a network round trip; the whole bug lives in
          // that window, so the fake has to have one too.
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (calls > 1) throw new Error('Unknown authorization code');
          return ACCOUNT;
        },
      });
      return { flow, calls: () => calls };
    }

    it('redeems the code once when all three paths report at the same time', async () => {
      const { flow, calls } = countingFlow();
      const coordinator = make(flow);
      await coordinator.begin();

      const url = `${REDIRECT}?code=abc&state=st`;
      await Promise.all([
        coordinator.onNavigation(42, url),
        coordinator.onNavigation(42, url),
        coordinator.onNavigation(42, url),
      ]);

      expect(calls()).toBe(1);
      expect(saved).toEqual([ACCOUNT]);
      const { lastResult } = await coordinator.progress();
      expect(lastResult).toMatchObject({ status: 'complete', email: ACCOUNT.email });
    });

    it('does not let a late duplicate overwrite the successful result', async () => {
      const { flow } = countingFlow();
      const coordinator = make(flow);
      await coordinator.begin();

      const url = `${REDIRECT}?code=abc&state=st`;
      await coordinator.onNavigation(42, url);
      // The relay content script reporting after the listeners already won.
      await coordinator.onNavigation(42, url);

      const { lastResult } = await coordinator.progress();
      expect(lastResult).toMatchObject({ status: 'complete' });
      expect(lastResult?.error).toBeUndefined();
    });

    it('claims the flow before exchanging, so a worker that dies mid-exchange cannot retry', async () => {
      let released!: () => void;
      const gate = new Promise<void>((resolve) => {
        released = resolve;
      });
      const flow = fakeFlow({
        complete: async () => {
          await gate;
          return ACCOUNT;
        },
      });
      const coordinator = make(flow);
      await coordinator.begin();

      const inFlight = coordinator.onNavigation(42, `${REDIRECT}?code=abc&state=st`);
      // Let the handler reach the exchange and block there.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // A worker woken now — a fresh coordinator over the same session storage —
      // must find nothing left to redeem.
      expect(await session.get(SIGNIN_KEY.pending)).toBeUndefined();

      released();
      await inFlight;
      expect(saved).toEqual([ACCOUNT]);
    });
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
