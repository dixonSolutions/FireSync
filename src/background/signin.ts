/**
 * Hosted sign-in, made survivable.
 *
 * The first version of this held the flow in a Promise: `state`, the PKCE
 * verifier and the ephemeral private key lived in a closure, and
 * `chrome.tabs.onUpdated` was registered inside it with a ten-minute timeout.
 * That cannot work. A Manifest V3 service worker is killed after roughly thirty
 * seconds of inactivity, and signing in to Mozilla — email, password, a
 * two-factor code fetched from a phone — takes longer than that. The worker
 * died mid-flow, taking the listener, the state and the timer with it, so when
 * the redirect finally arrived nothing was listening and the user was left
 * looking at a signed-out extension having just signed in.
 *
 * So nothing here lives in memory:
 *
 *   - The pending flow is persisted to `chrome.storage.session`, which survives
 *     worker restarts and dies with the browser. That is exactly the right
 *     lifetime for a code verifier and a single-use private key.
 *   - The navigation listeners are registered at the **top level** of the
 *     service worker, so they are re-registered every time it wakes, and a
 *     navigation is itself an event that wakes it.
 *
 * A trail of visited origins is kept purely so that a sign-in which fails for
 * some other reason can be diagnosed without guesswork. Query strings are
 * stripped: the redirect carries an authorization code.
 */

import type { KeyValueArea } from '../common/storage.ts';
import { DEFAULT_HOSTED_CLIENT_ID, FxAClient } from '../fxa/client.ts';
import { HostedSignIn } from '../fxa/hosted.ts';
import type { PendingHostedSignIn } from '../fxa/hosted.ts';
import type { AccountTokens } from '../vault/types.ts';

export const SIGNIN_KEY = {
  pending: 'firesync.signin.pending',
  result: 'firesync.signin.result',
} as const;

/** Abandon a flow the user clearly walked away from. */
export const SIGNIN_MAX_AGE_MS = 20 * 60_000;

/** How many navigations to remember, for diagnostics only. */
const TRAIL_LIMIT = 12;

interface StoredPending extends PendingHostedSignIn {
  tabId: number | null;
  /** Origin + path of each navigation, oldest first. No query strings. */
  trail: string[];
}

export interface SignInResult {
  status: 'complete' | 'error' | 'cancelled';
  at: number;
  email?: string;
  error?: string;
  trail?: string[];
}

export interface SignInProgress {
  active: boolean;
  startedAt: number | null;
  lastResult: SignInResult | null;
  trail: string[];
}

export interface SignInDeps {
  /** Memory-only: holds the PKCE verifier and the single-use private key. */
  session: KeyValueArea;
  /**
   * On-disk: holds only the redacted outcome and trail.
   *
   * The first version kept these in session storage too, which meant that when
   * a sign-in failed there was no way to find out where — the evidence died
   * with the worker. Diagnostics that vanish are not diagnostics.
   */
  local: KeyValueArea;
  /** Persist the account once the exchange succeeds. */
  saveAccount: (account: AccountTokens) => Promise<void>;
  onComplete?: (account: AccountTokens) => void;
  flow?: HostedSignIn;
  tabs?: {
    create: (url: string) => Promise<number | undefined>;
    remove: (tabId: number) => Promise<void>;
  };
  now?: () => number;
}

function chromeTabs(): NonNullable<SignInDeps['tabs']> {
  return {
    create: async (url) => (await chrome.tabs.create({ url, active: true })).id,
    remove: async (tabId) => {
      await chrome.tabs.remove(tabId).catch(() => undefined);
    },
  };
}

/** Strip everything but origin and path — the redirect carries a code. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return '(unparseable)';
  }
}

export class SignInCoordinator {
  private readonly session: KeyValueArea;
  private readonly local: KeyValueArea;
  private readonly saveAccount: SignInDeps['saveAccount'];
  private readonly onComplete: SignInDeps['onComplete'];
  private readonly flow: HostedSignIn;
  private readonly tabs: NonNullable<SignInDeps['tabs']>;
  private readonly now: () => number;

  constructor(deps: SignInDeps) {
    this.session = deps.session;
    this.local = deps.local;
    this.saveAccount = deps.saveAccount;
    this.onComplete = deps.onComplete;
    this.flow =
      deps.flow ??
      new HostedSignIn({
        client: new FxAClient({ oauthClientId: DEFAULT_HOSTED_CLIENT_ID }),
      });
    this.tabs = deps.tabs ?? chromeTabs();
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Start a sign-in and return immediately.
   *
   * Deliberately does not wait for the result: the caller is a popup that is
   * about to close, or an onboarding page that may itself be navigated away
   * from. Callers poll `progress()`.
   */
  async begin(email?: string): Promise<{ step: 'started' }> {
    await this.local.remove(SIGNIN_KEY.result);

    const pending = await this.flow.start(email ? { email } : {});
    const tabId = (await this.tabs.create(pending.authorizationUrl)) ?? null;

    const stored: StoredPending = { ...pending, tabId, trail: [] };
    await this.session.set(SIGNIN_KEY.pending, stored);
    return { step: 'started' };
  }

  /** Current state, for the UI to poll. */
  async progress(): Promise<SignInProgress> {
    const [pending, lastResult] = await Promise.all([
      this.session.get<StoredPending>(SIGNIN_KEY.pending),
      this.local.get<SignInResult>(SIGNIN_KEY.result),
    ]);
    return {
      active: pending !== undefined,
      startedAt: pending?.startedAt ?? null,
      lastResult: lastResult ?? null,
      trail: pending?.trail ?? lastResult?.trail ?? [],
    };
  }

  async cancel(reason = 'sign-in was cancelled'): Promise<void> {
    const pending = await this.session.get<StoredPending>(SIGNIN_KEY.pending);
    if (!pending) return;
    await this.finish({ status: 'cancelled', at: this.now(), error: reason, trail: pending.trail });
  }

  /**
   * Called for every navigation in every tab. Cheap when nothing is pending,
   * which is almost always.
   */
  async onNavigation(tabId: number, url: string | undefined): Promise<void> {
    if (!url) return;
    const pending = await this.session.get<StoredPending>(SIGNIN_KEY.pending);
    if (!pending) return;

    if (this.now() - pending.startedAt > SIGNIN_MAX_AGE_MS) {
      await this.finish({
        status: 'error',
        at: this.now(),
        error: 'sign-in took too long and was abandoned',
        trail: pending.trail,
      });
      return;
    }

    // Normally only the tab we opened matters. But the redirect can legitimately
    // arrive from elsewhere — the relay content script reports from whatever tab
    // it is running in, and a user may have moved the sign-in to a new window.
    // A URL that carries our exact `state` is proof enough on its own.
    const looksLikeOurRedirect = url.includes(encodeURIComponent(pending.state)) || url.includes(pending.state);
    if (pending.tabId !== null && tabId !== pending.tabId && !looksLikeOurRedirect) return;

    const step = redact(url);
    if (pending.trail[pending.trail.length - 1] !== step) {
      pending.trail = [...pending.trail, step].slice(-TRAIL_LIMIT);
      await this.session.set(SIGNIN_KEY.pending, pending);
    }

    let matches = false;
    try {
      matches = this.flow.matches(url, pending);
    } catch (error) {
      await this.finish({
        status: 'error',
        at: this.now(),
        error: error instanceof Error ? error.message : String(error),
        trail: pending.trail,
      });
      return;
    }
    if (!matches) return;

    try {
      const account = await this.flow.complete(url, pending);
      await this.saveAccount(account);
      if (pending.tabId !== null) await this.tabs.remove(pending.tabId);
      await this.finish({
        status: 'complete',
        at: this.now(),
        email: account.email,
        trail: pending.trail,
      });
      this.onComplete?.(account);
    } catch (error) {
      await this.finish({
        status: 'error',
        at: this.now(),
        error: error instanceof Error ? error.message : String(error),
        trail: pending.trail,
      });
    }
  }

  /** The user closed the sign-in tab. */
  async onTabClosed(tabId: number): Promise<void> {
    const pending = await this.session.get<StoredPending>(SIGNIN_KEY.pending);
    if (!pending || pending.tabId !== tabId) return;
    await this.finish({
      status: 'cancelled',
      at: this.now(),
      error: 'the sign-in tab was closed before it finished',
      trail: pending.trail,
    });
  }

  private async finish(result: SignInResult): Promise<void> {
    await this.session.remove(SIGNIN_KEY.pending);
    await this.local.set(SIGNIN_KEY.result, result);
  }

  /** Everything known about the last attempt, for the diagnostics panel. */
  async diagnostics(): Promise<SignInResult | null> {
    return (await this.local.get<SignInResult>(SIGNIN_KEY.result)) ?? null;
  }
}
