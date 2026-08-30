/**
 * Form-detection tests against realistic markup.
 *
 * These fixtures are the shapes that actually break naive detectors: a search
 * box above the login form, a signup form with two password fields, a
 * change-password form with three, a multi-step login with no password at all,
 * a honeypot field, and a login widget inside a shadow root.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyField,
  classifyFormKind,
  collectInputs,
  detectForms,
  findStandaloneUsernameField,
  isFillable,
  labelTextFor,
} from '../src/autofill/detector.ts';
import { fillLogin, generatePassword, readCredential, setFieldValue } from '../src/autofill/filler.ts';

function render(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('classifyField', () => {
  it('trusts autocomplete tokens above everything else', () => {
    render(`
      <input id="a" type="text" name="zip" autocomplete="username" />
      <input id="b" type="password" autocomplete="new-password" name="current_password" />
      <input id="c" type="password" autocomplete="current-password" />
      <input id="d" type="text" autocomplete="one-time-code" name="search" />
    `);
    const get = (id: string) => document.getElementById(id) as HTMLInputElement;
    expect(classifyField(get('a')).kind).toBe('username');
    expect(classifyField(get('b')).kind).toBe('new-password');
    expect(classifyField(get('c')).kind).toBe('current-password');
    expect(classifyField(get('d')).kind).toBe('totp');
  });

  it('recognises username-ish names, ids and placeholders', () => {
    render(`
      <input id="a" name="user_login" />
      <input id="b" id2="x" placeholder="Email address" />
      <input id="c" aria-label="Nom d'utilisateur" />
      <input id="d" name="benutzername" />
    `);
    for (const id of ['a', 'b', 'c', 'd']) {
      const kind = classifyField(document.getElementById(id) as HTMLInputElement).kind;
      expect(['username', 'email']).toContain(kind);
    }
  });

  it('refuses search, coupon and address fields', () => {
    render(`
      <input id="a" name="q" placeholder="Search" />
      <input id="b" name="coupon_code" />
      <input id="c" name="postal_code" />
      <input id="d" name="firstname" />
    `);
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(classifyField(document.getElementById(id) as HTMLInputElement).kind).toBe('unknown');
    }
  });

  it('distinguishes confirm and new password fields by name', () => {
    render(`
      <input id="a" type="password" name="new_password" />
      <input id="b" type="password" name="confirm_password" />
      <input id="c" type="password" name="old_password" />
    `);
    expect(classifyField(document.getElementById('a') as HTMLInputElement).kind).toBe('new-password');
    expect(classifyField(document.getElementById('b') as HTMLInputElement).kind).toBe(
      'confirm-password',
    );
    expect(classifyField(document.getElementById('c') as HTMLInputElement).kind).toBe(
      'current-password',
    );
  });

  it('reads a label rather than guessing from an opaque name', () => {
    render(`
      <label for="x9f2">Username</label>
      <input id="x9f2" name="a1b2c3" />
    `);
    const input = document.getElementById('x9f2') as HTMLInputElement;
    expect(labelTextFor(input)).toBe('Username');
    expect(classifyField(input).kind).toBe('username');
  });

  it('reads an aria-labelledby label', () => {
    render(`
      <span id="lbl">Email</span>
      <input id="f" aria-labelledby="lbl" name="zzz" />
    `);
    expect(labelTextFor(document.getElementById('f') as HTMLInputElement)).toBe('Email');
  });
});

describe('isFillable', () => {
  it('rejects hidden, disabled and readonly fields', () => {
    render(`
      <input id="a" type="hidden" name="username" />
      <input id="b" name="username" disabled />
      <input id="c" name="username" readonly />
      <input id="d" name="username" hidden />
      <input id="e" name="username" aria-hidden="true" />
      <input id="f" name="username" style="display:none" />
      <input id="g" name="username" />
    `);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(isFillable(document.getElementById(id) as HTMLInputElement)).toBe(false);
    }
    expect(isFillable(document.getElementById('g') as HTMLInputElement)).toBe(true);
  });
});

describe('detectForms — real-world shapes', () => {
  it('handles a plain login form', () => {
    render(`
      <form action="/session" method="post">
        <input name="email" placeholder="Email" />
        <input name="password" type="password" />
        <button type="submit">Sign in</button>
      </form>
    `);
    const [form] = detectForms(document);
    expect(form?.kind).toBe('login');
    expect(form?.username?.getAttribute('name')).toBe('email');
    expect(form?.currentPassword?.getAttribute('name')).toBe('password');
    expect(form?.submit?.textContent).toBe('Sign in');
  });

  it('is not fooled by a search box above the form', () => {
    render(`
      <input name="q" placeholder="Search the site" />
      <form>
        <input name="login" placeholder="Username" />
        <input name="pass" type="password" />
      </form>
    `);
    const [form] = detectForms(document);
    expect(form?.username?.getAttribute('name')).toBe('login');
  });

  it('classifies a signup form and does not treat it as a login', () => {
    render(`
      <form>
        <input name="email" type="email" autocomplete="email" />
        <input name="password" type="password" autocomplete="new-password" />
        <input name="password_confirmation" type="password" autocomplete="new-password" />
      </form>
    `);
    const [form] = detectForms(document);
    expect(form?.kind).toBe('signup');
    expect(form?.newPassword).not.toBeNull();
  });

  it('classifies a change-password form', () => {
    render(`
      <form>
        <input name="current_password" type="password" autocomplete="current-password" />
        <input name="new_password" type="password" autocomplete="new-password" />
        <input name="confirm_new_password" type="password" />
      </form>
    `);
    const [form] = detectForms(document);
    expect(form?.kind).toBe('change-password');
    expect(form?.currentPassword?.getAttribute('name')).toBe('current_password');
    expect(form?.newPassword?.getAttribute('name')).toBe('new_password');
  });

  it('ignores a honeypot field', () => {
    render(`
      <form>
        <input name="bot-field" style="display:none" />
        <input name="username" />
        <input name="password" type="password" />
      </form>
    `);
    const [form] = detectForms(document);
    expect(form?.username?.getAttribute('name')).toBe('username');
    expect(form?.fields.some((field) => field.element.getAttribute('name') === 'bot-field')).toBe(
      false,
    );
  });

  it('handles a form-less login widget', () => {
    render(`
      <div class="login">
        <input name="user" />
        <input name="pass" type="password" />
        <div role="button">Log in</div>
      </div>
    `);
    const [form] = detectForms(document);
    expect(form?.form).toBeNull();
    expect(form?.username?.getAttribute('name')).toBe('user');
    expect(form?.submit?.textContent).toBe('Log in');
  });

  it('keeps two forms on one page apart', () => {
    render(`
      <form id="signin"><input name="user" /><input name="pass" type="password" /></form>
      <form id="register">
        <input name="new_user" />
        <input name="new_password" type="password" autocomplete="new-password" />
      </form>
    `);
    const forms = detectForms(document);
    expect(forms).toHaveLength(2);
    expect(forms.map((form) => form.kind).sort()).toEqual(['login', 'signup']);
  });

  it('descends into an open shadow root', () => {
    render('<div id="host"></div>');
    const host = document.getElementById('host') as HTMLElement;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input name="username" /><input name="password" type="password" />';

    expect(collectInputs(document)).toHaveLength(2);
    const [form] = detectForms(document);
    expect(form?.currentPassword?.getAttribute('name')).toBe('password');
  });

  it('finds the username field on a password-less first step', () => {
    render(`
      <form>
        <input name="email" type="email" autocomplete="username" />
        <button type="submit">Next</button>
      </form>
    `);
    expect(detectForms(document)).toHaveLength(0);
    expect(findStandaloneUsernameField(document)?.getAttribute('name')).toBe('email');
  });

  it('detects a TOTP-only step', () => {
    render('<form><input name="otp_code" autocomplete="one-time-code" /></form>');
    const [form] = detectForms(document);
    expect(form?.kind).toBe('totp');
    expect(form?.totp).not.toBeNull();
  });

  it('returns nothing on a page with no credential fields', () => {
    render('<form><input name="q" /><textarea></textarea></form>');
    expect(detectForms(document)).toHaveLength(0);
  });
});

describe('classifyFormKind', () => {
  it('maps password-field counts to intent', () => {
    render(`
      <input id="cur" type="password" autocomplete="current-password" />
      <input id="new" type="password" autocomplete="new-password" />
      <input id="conf" type="password" name="confirm_password" />
    `);
    const get = (id: string) => document.getElementById(id) as HTMLInputElement;

    expect(classifyFormKind([get('cur')], false)).toBe('login');
    expect(classifyFormKind([get('new'), get('conf')], false)).toBe('signup');
    expect(classifyFormKind([get('cur'), get('new')], false)).toBe('change-password');
    expect(classifyFormKind([], true)).toBe('totp');
    expect(classifyFormKind([], false)).toBe('unknown');
  });
});

describe('filler', () => {
  it('fills a login and fires the events frameworks listen for', () => {
    render('<form><input name="user" /><input name="pass" type="password" /></form>');
    const [form] = detectForms(document);

    const events: string[] = [];
    for (const type of ['input', 'change', 'keyup']) {
      document.addEventListener(type, (event) => events.push(`${type}:${(event.target as HTMLInputElement).name}`));
    }

    const report = fillLogin(form!, { username: 'ada', password: 'hunter2' });

    expect(report).toEqual({ filledUsername: true, filledPassword: true });
    expect((form?.username as HTMLInputElement).value).toBe('ada');
    expect((form?.currentPassword as HTMLInputElement).value).toBe('hunter2');
    expect(events).toContain('input:user');
    expect(events).toContain('change:pass');
  });

  it('never fills a new-password field from a saved login', () => {
    render(`
      <form>
        <input name="user" />
        <input name="pass" type="password" autocomplete="new-password" />
      </form>
    `);
    const [form] = detectForms(document);
    fillLogin(form!, { username: 'ada', password: 'hunter2' });
    expect((form?.newPassword as HTMLInputElement).value).toBe('');
  });

  it('reads back what the user typed', () => {
    render('<form action="/session"><input name="user" /><input name="pass" type="password" /></form>');
    const [form] = detectForms(document);
    setFieldValue(form!.username as HTMLInputElement, 'ada');
    setFieldValue(form!.currentPassword as HTMLInputElement, 'hunter2');

    expect(readCredential(form!)).toEqual({
      username: 'ada',
      password: 'hunter2',
      usernameField: 'user',
      passwordField: 'pass',
    });
  });

  it('reads nothing when the password field is empty', () => {
    render('<form><input name="user" value="ada" /><input name="pass" type="password" /></form>');
    const [form] = detectForms(document);
    expect(readCredential(form!)).toBeNull();
  });
});

describe('generatePassword', () => {
  it('produces the requested length from an unambiguous alphabet', () => {
    const password = generatePassword(24);
    expect(password).toHaveLength(24);
    expect(password).not.toMatch(/[Il1O0]/);
  });

  it('does not repeat itself', () => {
    expect(new Set(Array.from({ length: 200 }, () => generatePassword())).size).toBe(200);
  });
});
