/**
 * The content script.
 *
 * Lives in the isolated world on every page, in every frame. It knows about
 * fields and pixels; it knows nothing about crypto, and it never holds more
 * vault data than the menu currently on screen needs.
 */

import { sendMessage } from '../common/messages.ts';
import type { Broadcast, CapturedCredential, CredentialSummary } from '../common/messages.ts';
import { detectForms, findStandaloneUsernameField } from './detector.ts';
import type { DetectedForm } from './detector.ts';
import { fillLogin, readCredential } from './filler.ts';
import {
  anchorTo,
  createOverlay,
  placeInFieldButton,
  placeMenu,
  removeStaleOverlays,
} from './overlay.ts';
import type { OverlayHandle } from './overlay.ts';

interface MenuState {
  handle: OverlayHandle;
  detach: () => void;
  form: DetectedForm;
}

interface ButtonState {
  handle: OverlayHandle;
  detach: () => void;
  field: HTMLInputElement;
}

const state: {
  forms: DetectedForm[];
  matches: CredentialSummary[];
  button: ButtonState | null;
  menu: MenuState | null;
  bar: { handle: OverlayHandle } | null;
  pending: CapturedCredential | null;
  inlineMenu: string;
  unlocked: boolean;
} = {
  forms: [],
  matches: [],
  button: null,
  menu: null,
  bar: null,
  pending: null,
  inlineMenu: 'on',
  unlocked: false,
};

// --------------------------------------------------------------------- detect

function anchorField(form: DetectedForm): HTMLInputElement | null {
  return form.username ?? form.currentPassword ?? form.newPassword ?? null;
}

async function refresh(): Promise<void> {
  const forms = detectForms(document);
  if (!forms.length) {
    const standalone = findStandaloneUsernameField(document);
    if (!standalone) {
      teardownButton();
      return;
    }
    state.forms = [
      {
        form: standalone.form,
        kind: 'login',
        username: standalone,
        currentPassword: null,
        newPassword: null,
        confirmPassword: null,
        totp: null,
        submit: null,
        fields: [],
      },
    ];
  } else {
    state.forms = forms;
  }

  let response;
  try {
    response = await sendMessage({ type: 'autofill/query', pageUrl: location.href });
  } catch {
    return; // service worker asleep or extension reloading; try again later
  }

  state.matches = response.matches;
  state.inlineMenu = response.inlineMenu;
  state.unlocked = response.unlocked;

  if (response.inlineMenu === 'off') {
    teardownButton();
    return;
  }

  const loginForm = state.forms.find((form) => form.kind === 'login' || form.kind === 'unknown');
  const field = loginForm ? anchorField(loginForm) : null;
  if (!field || !loginForm) {
    teardownButton();
    return;
  }

  mountButton(field);

  if (response.autoFill && response.unlocked && response.matches.length === 1) {
    const only = response.matches[0];
    if (only) await fillById(only.id, loginForm);
  }
}

// --------------------------------------------------------------- inline menu

function teardownButton(): void {
  state.button?.detach();
  state.button?.handle.destroy();
  state.button = null;
  teardownMenu();
}

function teardownMenu(): void {
  state.menu?.detach();
  state.menu?.handle.destroy();
  state.menu = null;
}

function mountButton(field: HTMLInputElement): void {
  if (state.button?.field === field) return;
  teardownButton();

  const handle = createOverlay({
    page: 'menu-button.html',
    kind: 'button',
    style: {},
    onMessage: (message) => {
      const data = message as { type?: string };
      if (data.type === 'button/click') void toggleMenu(field);
    },
  });
  const detach = anchorTo(handle, field, placeInFieldButton);
  state.button = { handle, detach, field };
}

async function toggleMenu(field: HTMLInputElement): Promise<void> {
  if (state.menu) {
    teardownMenu();
    return;
  }
  const form = state.forms.find((candidate) => anchorField(candidate) === field);
  if (!form) return;

  const handle = createOverlay({
    page: 'menu.html',
    kind: 'menu',
    style: { height: '0px' },
    onMessage: (message) => void onMenuMessage(message, form),
  });
  const detach = anchorTo(handle, field, placeMenu);
  state.menu = { handle, detach, form };

  handle.iframe.addEventListener('load', () => {
    handle.post({
      type: 'menu/init',
      matches: state.matches,
      unlocked: state.unlocked,
      pageUrl: location.href,
    });
  });
}

async function onMenuMessage(message: unknown, form: DetectedForm): Promise<void> {
  const data = message as { type?: string; id?: string; height?: number };
  switch (data.type) {
    case 'menu/resize':
      if (state.menu && typeof data.height === 'number') {
        state.menu.handle.host.style.height = `${Math.min(320, data.height)}px`;
      }
      break;
    case 'menu/fill':
      if (data.id) await fillById(data.id, form);
      teardownMenu();
      break;
    case 'menu/close':
      teardownMenu();
      break;
    default:
      break;
  }
}

async function fillById(id: string, form: DetectedForm): Promise<void> {
  const credential = await sendMessage({
    type: 'autofill/reveal',
    id,
    pageUrl: location.href,
  });
  if (!credential?.password) return;
  fillLogin(form, { username: credential.username, password: credential.password });
}

// ------------------------------------------------------------ save / update

function captureFrom(form: DetectedForm): CapturedCredential | null {
  const values = readCredential(form);
  if (!values) return null;
  const action = form.form?.getAttribute('action');
  let formActionOrigin: string | null = null;
  try {
    formActionOrigin = action ? new URL(action, location.href).origin : location.origin;
  } catch {
    formActionOrigin = location.origin;
  }
  return {
    pageUrl: location.href,
    origin: location.origin,
    username: values.username,
    password: values.password,
    formActionOrigin,
    usernameField: values.usernameField,
    passwordField: values.passwordField,
  };
}

function rememberSubmission(): void {
  for (const form of state.forms) {
    const captured = captureFrom(form);
    if (captured) {
      state.pending = captured;
      return;
    }
  }
}

async function maybePromptToSave(): Promise<void> {
  const captured = state.pending;
  if (!captured) return;
  state.pending = null;

  let verdict;
  try {
    verdict = await sendMessage({ type: 'autofill/captured', credential: captured });
  } catch {
    return;
  }
  if (!verdict.shouldPrompt) return;

  if (verdict.existingCredentialId) captured.existingCredentialId = verdict.existingCredentialId;
  showNotificationBar(captured);
}

function showNotificationBar(captured: CapturedCredential): void {
  state.bar?.handle.destroy();

  const handle = createOverlay({
    page: 'notification.html',
    kind: 'bar',
    style: {
      position: 'fixed',
      top: '12px',
      right: '12px',
      left: 'auto',
      width: '380px',
      height: '132px',
    },
    onMessage: (message) => void onBarMessage(message, captured),
  });
  state.bar = { handle };

  handle.iframe.addEventListener('load', () => {
    handle.post({
      type: 'bar/init',
      mode: captured.existingCredentialId ? 'update' : 'save',
      username: captured.username,
      origin: captured.origin,
    });
  });
}

async function onBarMessage(message: unknown, captured: CapturedCredential): Promise<void> {
  const data = message as { type?: string; height?: number };
  switch (data.type) {
    case 'bar/save':
      if (captured.existingCredentialId) {
        await sendMessage({
          type: 'autofill/updateExisting',
          id: captured.existingCredentialId,
          password: captured.password,
        });
      } else {
        await sendMessage({ type: 'autofill/save', credential: captured });
      }
      dismissBar();
      break;
    case 'bar/never':
      await sendMessage({ type: 'prefs/neverSave', pageUrl: captured.pageUrl });
      dismissBar();
      break;
    case 'bar/dismiss':
      dismissBar();
      break;
    case 'bar/resize':
      if (state.bar && typeof data.height === 'number') {
        state.bar.handle.host.style.height = `${data.height}px`;
      }
      break;
    default:
      break;
  }
}

function dismissBar(): void {
  state.bar?.handle.destroy();
  state.bar = null;
}

// ------------------------------------------------------------------ lifecycle

function observeDom(): void {
  let scheduled = 0;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = window.setTimeout(() => {
      scheduled = 0;
      void refresh();
    }, 250);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'autocomplete', 'style', 'class'],
  });
}

function observeSubmission(): void {
  document.addEventListener('submit', rememberSubmission, true);
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter') rememberSubmission();
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('button, [type="submit"], [role="button"]')) rememberSubmission();
    },
    true,
  );
  window.addEventListener('pagehide', () => void maybePromptToSave());

  // XHR logins never navigate, so also prompt when the password field goes
  // away shortly after we captured something.
  const observer = new MutationObserver(() => {
    if (!state.pending) return;
    const stillThere = document.querySelector('input[type="password"]');
    if (!stillThere) void maybePromptToSave();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function listenForBroadcasts(): void {
  chrome.runtime.onMessage.addListener((message: Broadcast) => {
    if (message.type === 'state/locked') {
      state.unlocked = false;
      state.matches = [];
      teardownMenu();
    }
    if (message.type === 'state/unlocked') void refresh();
  });
}

function start(): void {
  if (window.top !== window.self && window.innerHeight < 40) return; // tracking pixel frames
  removeStaleOverlays();
  void refresh();
  observeDom();
  observeSubmission();
  listenForBroadcasts();
  document.addEventListener('focusin', (event) => {
    const target = event.target as HTMLElement | null;
    if (target instanceof HTMLInputElement) void refresh();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') teardownMenu();
  });
}

start();
