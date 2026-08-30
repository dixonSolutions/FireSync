/**
 * First-run setup: create the local vault, then connect the Mozilla account.
 *
 * A long-lived port keeps the service worker alive for the whole sign-in, so an
 * in-flight `ConnectSession` — which holds a session token in memory only —
 * survives the pause while the user fetches a 2FA code.
 */

import { sendMessage } from '../../common/messages.ts';

chrome.runtime.connect({ name: 'firesync.keepalive' });

const show = (id: string, visible: boolean): void => {
  const element = document.getElementById(id);
  if (element) element.hidden = !visible;
};

const text = (id: string, value: string): void => {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
};

// ------------------------------------------------------------------ step 1
(document.getElementById('vault-form') as HTMLFormElement).addEventListener(
  'submit',
  async (event) => {
    event.preventDefault();
    const first = (document.getElementById('pass1') as HTMLInputElement).value;
    const second = (document.getElementById('pass2') as HTMLInputElement).value;

    if (first.length < 10) {
      text('vault-error', 'Use at least 10 characters. This is the only thing protecting the vault on disk.');
      return;
    }
    if (first !== second) {
      text('vault-error', 'Those passphrases do not match.');
      return;
    }
    try {
      await sendMessage({ type: 'vault/create', passphrase: first });
      show('step-vault', false);
      show('step-account', true);
      (document.getElementById('email') as HTMLInputElement).focus();
    } catch (error) {
      text('vault-error', error instanceof Error ? error.message : String(error));
    }
  },
);

// ------------------------------------------------------------------ step 2
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

// Skip step 1 if a vault already exists.
void (async () => {
  const status = await sendMessage({ type: 'vault/status' }).catch(() => null);
  if (!status) return;
  if (status.initialized && status.unlocked && !status.connected) {
    show('step-vault', false);
    show('step-account', true);
  }
  if (status.connected) {
    show('step-vault', false);
    show('step-done', true);
  }
})();
