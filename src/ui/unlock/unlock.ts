import { sendMessage } from '../../common/messages.ts';

const form = document.getElementById('form') as HTMLFormElement;
const input = document.getElementById('passphrase') as HTMLInputElement;
const submit = document.getElementById('submit') as HTMLButtonElement;
const errorEl = document.getElementById('error') as HTMLDivElement;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';
  submit.disabled = true;
  submit.textContent = 'Unlocking…';
  try {
    await sendMessage({ type: 'vault/unlock', passphrase: input.value });
    location.href = 'popup.html';
  } catch (error) {
    // Deliberately generic: distinguishing "no vault" from "wrong passphrase"
    // tells an attacker with disk access which half they got wrong.
    errorEl.textContent = 'That passphrase did not unlock the vault.';
    input.select();
  } finally {
    submit.disabled = false;
    submit.textContent = 'Unlock';
  }
});

void (async () => {
  const status = await sendMessage({ type: 'vault/status' }).catch(() => null);
  if (status && !status.initialized) location.href = 'onboarding.html';
  if (status?.unlocked) location.href = 'popup.html';
})();
