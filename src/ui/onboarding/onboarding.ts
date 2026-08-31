/**
 * First-run setup: create the local vault, then connect the Mozilla account.
 *
 * A long-lived port keeps the service worker alive for the whole sign-in, so an
 * in-flight `ConnectSession` — which holds a session token in memory only —
 * survives the pause while the user fetches a 2FA code.
 */

import { sendMessage } from '../../common/messages.ts';
import { waitForSignIn } from '../wait-for-signin.ts';

chrome.runtime.connect({ name: 'firesync.keepalive' });

const show = (id: string, visible: boolean): void => {
  const element = document.getElementById(id);
  if (element) element.hidden = !visible;
};

const text = (id: string, value: string): void => {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
};

// ------------------------------------------------------------------ step 2

/**
 * The preferred route: Mozilla's own sign-in page in a new tab. The background
 * watches that tab for the OAuth redirect, so this just waits for the answer.
 */
/** Move the UI to whatever the sign-in machine says is next. */
function handleStep(step: string): void {
  switch (step) {
    case 'complete':
      show('step-account', false);
      show('step-done', true);
      break;
    case 'needs-totp':
      show('second-factor', true);
      show('resend', false);
      text('code-label', 'Code from your authenticator app');
      break;
    case 'needs-email-code':
      show('second-factor', true);
      show('resend', true);
      text('code-label', 'Code from the email Mozilla just sent you');
      break;
    case 'needs-unblock-code':
      show('second-factor', true);
      show('resend', false);
      text('code-label', 'Authorization code from the email Mozilla just sent you');
      text(
        'account-error',
        'Mozilla flagged this as a new device. Enter the code from the email, then press Connect again.',
      );
      break;
    default:
      break;
  }
}

document.getElementById('hosted-signin')?.addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  button.textContent = 'Opening Mozilla sign-in…';
  text('hosted-error', '');

  try {
    await sendMessage({ type: 'account/signInHosted' });
    button.textContent = 'Waiting for you to finish signing in…';

    const result = await waitForSignIn({
      onTrail: (trail) => {
        const last = trail[trail.length - 1];
        if (last) text('hosted-error', `At ${last}`);
      },
    });

    if (result.status === 'complete') {
      text('hosted-error', '');
      handleStep('complete');
      return;
    }
    // Mozilla finished the sign-in but handed back no key. That is a dead end
    // for this route and only this route: the password flow derives the key
    // locally instead of relying on the content server to have it in the
    // session, which is exactly the case for an account authenticated through
    // Google or Apple. So open that route rather than describing the problem.
    if (result.reason === 'no-sync-key') {
      const fallback = document.getElementById('password-fallback') as HTMLDetailsElement | null;
      if (fallback) {
        fallback.open = true;
        fallback.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      text(
        'hosted-error',
        `${result.error ?? 'Mozilla returned no sync key.'} ` +
          'Signing in with your Mozilla password instead will work — the form below derives ' +
          'the key on this machine. If the account has no Mozilla password yet, set one at ' +
          'accounts.firefox.com first; Firefox Sync needs it too.',
      );
      return;
    }

    text(
      'hosted-error',
      result.status === 'cancelled'
        ? 'Sign-in was cancelled. Press the button to try again.'
        : (result.error ?? 'Sign-in did not complete.') +
            (result.trail?.length ? ` (last page: ${result.trail[result.trail.length - 1]})` : ''),
    );
  } catch (error) {
    text('hosted-error', error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in at accounts.firefox.com';
  }
});

(document.getElementById('account-form') as HTMLFormElement).addEventListener(
  'submit',
  async (event) => {
    event.preventDefault();
    text('account-error', '');
    const email = (document.getElementById('email') as HTMLInputElement).value.trim();
    const password = (document.getElementById('password') as HTMLInputElement).value;
    const unblock = (document.getElementById('code') as HTMLInputElement).value.trim();

    try {
      const result = await sendMessage({
        type: 'account/connect',
        email,
        password,
        ...(unblock ? { unblockCode: unblock } : {}),
      });
      handleStep(result.step);
    } catch (error) {
      text('account-error', error instanceof Error ? error.message : String(error));
    }
  },
);

document.getElementById('submit-code')?.addEventListener('click', async () => {
  text('account-error', '');
  const code = (document.getElementById('code') as HTMLInputElement).value.trim();
  const label = document.getElementById('code-label')?.textContent ?? '';
  try {
    const result = label.includes('authenticator')
      ? await sendMessage({ type: 'account/submitTotp', code })
      : await sendMessage({ type: 'account/submitEmailCode', code });
    handleStep(result.step);
  } catch (error) {
    text('account-error', error instanceof Error ? error.message : String(error));
  }
});

document.getElementById('resend')?.addEventListener('click', async () => {
  await sendMessage({ type: 'account/resendEmailCode' }).catch(() => undefined);
  text('account-error', 'Sent. Check your inbox.');
});

document.getElementById('finish')?.addEventListener('click', () => {
  window.close();
});

// If an account is already connected there is nothing to set up.
void (async () => {
  const status = await sendMessage({ type: 'vault/status' }).catch(() => null);
  if (status?.connected) {
    show('step-account', false);
    show('step-done', true);
  }
})();
