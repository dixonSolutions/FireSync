/**
 * Writing values into page fields.
 *
 * Setting `input.value` directly is not enough on any modern framework: React
 * tracks the previous value on the DOM node and will treat a direct assignment
 * as a no-op, silently reverting the field on the next render. The fix is to
 * call the *native* value setter and then dispatch the events the framework is
 * listening for.
 */

import type { DetectedForm } from './detector.ts';

export interface FillReport {
  filledUsername: boolean;
  filledPassword: boolean;
}

/** Set a value in a way React, Vue, Angular and Svelte all notice. */
export function setFieldValue(input: HTMLInputElement, value: string): void {
  const prototype = Object.getPrototypeOf(input) as object;
  const descriptor =
    Object.getOwnPropertyDescriptor(prototype, 'value') ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  input.focus();
  if (descriptor?.set) descriptor.set.call(input, value);
  else input.value = value;

  for (const type of ['input', 'change'] as const) {
    input.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }
  // Some widgets only commit on keyboard activity.
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true }));
}

/** Fill a detected login form. Never touches new-password fields. */
export function fillLogin(
  form: DetectedForm,
  credential: { username: string; password: string },
): FillReport {
  const report: FillReport = { filledUsername: false, filledPassword: false };

  if (form.username && credential.username) {
    setFieldValue(form.username, credential.username);
    report.filledUsername = true;
  }
  if (form.currentPassword && credential.password) {
    setFieldValue(form.currentPassword, credential.password);
    report.filledPassword = true;
  }
  return report;
}

/** Fill a generated password into a signup or change-password form. */
export function fillNewPassword(form: DetectedForm, password: string): FillReport {
  const report: FillReport = { filledUsername: false, filledPassword: false };
  const target = form.newPassword ?? form.currentPassword;
  if (target) {
    setFieldValue(target, password);
    report.filledPassword = true;
  }
  if (form.confirmPassword) setFieldValue(form.confirmPassword, password);
  return report;
}

/** Read the current values out of a form, for save/update capture. */
export function readCredential(form: DetectedForm): {
  username: string;
  password: string;
  usernameField: string;
  passwordField: string;
} | null {
  const password = form.currentPassword ?? form.newPassword;
  if (!password || !password.value) return null;
  return {
    username: form.username?.value ?? '',
    password: password.value,
    usernameField: form.username?.getAttribute('name') ?? '',
    passwordField: password.getAttribute('name') ?? '',
  };
}

/**
 * A generated password: 20 characters from an unambiguous alphabet, drawn with
 * rejection sampling so the distribution is uniform (modulo bias in a password
 * generator is a real, if small, weakness).
 */
export function generatePassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
  const max = 256 - (256 % alphabet.length);
  const out: string[] = [];
  const buffer = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte >= max) continue;
      out.push(alphabet[byte % alphabet.length] as string);
      if (out.length === length) break;
    }
  }
  return out.join('');
}
