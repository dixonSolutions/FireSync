/**
 * Wait for a hosted sign-in to finish.
 *
 * The background no longer resolves a promise when sign-in completes, because
 * the service worker that would have held it is routinely killed mid-flow. It
 * records the outcome instead, so the UI polls. Polling is also the only thing
 * that works when the caller is a popup that closed and was reopened.
 */

import { sendMessage } from '../common/messages.ts';
import type { SignInProgress, SignInResult } from '../background/signin.ts';

export interface WaitOptions {
  /** Called whenever the sign-in tab navigates, for progress display. */
  onTrail?: (trail: string[]) => void;
  intervalMs?: number;
  timeoutMs?: number;
}

export async function waitForSignIn(options: WaitOptions = {}): Promise<SignInResult> {
  const interval = options.intervalMs ?? 1500;
  const deadline = Date.now() + (options.timeoutMs ?? 20 * 60_000);
  let lastTrail = '';

  for (;;) {
    let progress: SignInProgress;
    try {
      progress = await sendMessage({ type: 'account/signInProgress' });
    } catch {
      // The worker may be restarting; that is normal, not a failure.
      await sleep(interval);
      continue;
    }

    const trail = progress.trail.join('>');
    if (trail !== lastTrail) {
      lastTrail = trail;
      options.onTrail?.(progress.trail);
    }

    if (progress.lastResult) return progress.lastResult;

    if (!progress.active) {
      return { status: 'error', at: Date.now(), error: 'sign-in is no longer running' };
    }
    if (Date.now() > deadline) {
      return { status: 'error', at: Date.now(), error: 'timed out waiting for sign-in' };
    }
    await sleep(interval);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
