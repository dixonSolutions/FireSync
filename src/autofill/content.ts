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
  isOverlayHost,
  placeInFieldButton,
  placeMenu,
  removeStaleOverlays,
} from './overlay.ts';
import type { Anchor, OverlayHandle } from './overlay.ts';

interface MenuState {
  handle: OverlayHandle;
  anchor: Anchor;
  form: DetectedForm;
  field: HTMLInputElement;
  /** Whether the iframe has loaded and there is a window to talk to. */
  ready: boolean;
  /** The last placement sent, so scrolling does not post a message per frame. */
  placement: string;
}

interface ButtonState {
  handle: OverlayHandle;
  anchor: Anchor;
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
  /** The credential field the page currently has focus in, if any. */
  focused: HTMLInputElement | null;
  /** Set while filling, whose focus() calls must not reopen the popover. */
  filling: boolean;
} = {
  forms: [],
  matches: [],
  button: null,
  menu: null,
  bar: null,
  pending: null,
  inlineMenu: 'on',
  unlocked: false,
  focused: null,
  filling: false,
};

// --------------------------------------------------------------------- detect

function anchorField(form: DetectedForm): HTMLInputElement | null {
  return form.username ?? form.currentPassword ?? form.newPassword ?? null;
}

/** The fields on a form the inline menu is willing to sit on. */
function menuFields(form: DetectedForm): HTMLInputElement[] {
  return [form.username, form.currentPassword, form.newPassword].filter(
    (field): field is HTMLInputElement => field !== null,
  );
}

function formForField(field: HTMLInputElement): DetectedForm | null {
  return state.forms.find((form) => menuFields(form).includes(field)) ?? null;
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
  if (!loginForm || !anchorField(loginForm)) {
    teardownButton();
    return;
  }

  placeButton();

  if (response.autoFill && response.unlocked && response.matches.length === 1) {
    const only = response.matches[0];
    if (only) await fillById(only.id, loginForm);
  }
}

// --------------------------------------------------------------- inline menu

function teardownButton(): void {
  state.button?.anchor.detach();
  state.button?.handle.destroy();
  state.button = null;
  teardownMenu();
}

function teardownMenu(): void {
  state.menu?.anchor.detach();
  state.menu?.handle.destroy();
  state.menu = null;
}

/**
 * Put the icon where the user is looking.
 *
 * On the focused credential field when there is one — a page with a username
 * and a password field has two places the icon belongs, and the right one is
 * whichever the user is in. With nothing focused it falls back to the form's
 * own anchor field, so the icon is still there to be clicked.
 */
function placeButton(): void {
  const focused = state.focused;
  if (focused && formForField(focused)) {
    mountButton(focused);
    return;
  }
  const form = state.forms.find(
    (candidate) => candidate.kind === 'login' || candidate.kind === 'unknown',
  );
  const field = form ? anchorField(form) : null;
  if (field) mountButton(field);
  else teardownButton();
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
  const anchor = anchorTo(handle, field, placeInFieldButton);
  state.button = { handle, anchor, field };
}

/** Clicking the icon is a toggle, and opening that way means the user wants the list. */
async function toggleMenu(field: HTMLInputElement): Promise<void> {
  if (state.menu?.field === field) {
    teardownMenu();
    return;
  }
  await openMenu(field, true);
}

async function openMenu(field: HTMLInputElement, focusList: boolean): Promise<void> {
  const form = formForField(field);
  if (!form) return;

  if (state.menu?.field === field) {
    if (focusList) state.menu.handle.post({ type: 'menu/focus' });
    return;
  }
  teardownMenu();

  const handle = createOverlay({
    page: 'menu.html',
    kind: 'menu',
    style: { height: '0px' },
    onMessage: (message) => void onMenuMessage(message, form),
  });

  // placeMenu works out the side and the caret, but only the menu page can draw
  // them, so each placement that actually differs is forwarded into the iframe.
  const anchor = anchorTo(handle, field, (rect, host) => {
    const placement = placeMenu(rect, host);
    const key = `${placement.side}:${Math.round(placement.caret)}`;
    const menu = state.menu;
    // `ready` is the whole reason this is not just a cache. Anchoring places
    // the overlay straight away, while the iframe is still the blank document
    // it starts life as — posting there reaches nobody, and recording it as
    // sent would suppress the identical placement the real page needs.
    if (!menu || menu.handle !== handle || !menu.ready || menu.placement === key) return;
    menu.placement = key;
    handle.post({ type: 'menu/place', side: placement.side, caret: placement.caret });
  });
  state.menu = { handle, anchor, form, field, ready: false, placement: '' };

  handle.iframe.addEventListener('load', () => {
    const menu = state.menu;
    if (!menu || menu.handle !== handle) return; // replaced while it was loading
    handle.post({
      type: 'menu/init',
      matches: state.matches,
      unlocked: state.unlocked,
      pageUrl: location.href,
      focusList,
    });
    menu.ready = true;
    menu.anchor.reposition();
  });
}

/**
 * Whether focusing a field should open the popover by itself.
 *
 * Only when there is something in it to pick. "No saved logins for this site"
 * is worth saying to someone who asked by clicking the icon, and is a box over
 * the page for everyone who just clicked into a login field.
 */
function shouldOpenOnFocus(): boolean {
  return state.inlineMenu !== 'off' && state.unlocked && state.matches.length > 0;
}

/**
 * Focus inside our own overlays is not focus leaving the field.
 *
 * Clicking the icon or an entry in the list moves focus into an iframe of ours.
 * Focus in a shadow tree is reported as the host element, which is the element
 * `isOverlayHost` recognises.
 */
function focusIsOurs(): boolean {
  return isOverlayHost(document.activeElement);
}

/**
 * `duringFill` is read by the caller, before the await, because by the time
 * this resumes the fill is long over. Filling focuses each field it writes, so
 * without it choosing a login would hand the popover straight back.
 */
async function fieldFocused(field: HTMLInputElement, duringFill: boolean): Promise<void> {
  await refresh();
  if (state.focused !== field) return; // focus moved on while we were asking
  if (!formForField(field)) return;

  mountButton(field);
  if (!duringFill && shouldOpenOnFocus()) await openMenu(field, false);
  else teardownMenu();
}

async function onMenuMessage(message: unknown, form: DetectedForm): Promise<void> {
  const data = message as { type?: string; id?: string; height?: number };
  switch (data.type) {
    case 'menu/resize':
      if (state.menu && typeof data.height === 'number') {
        state.menu.handle.host.style.height = `${Math.min(320, data.height)}px`;
        // The height decides whether it still fits below the field, so the
        // placement is only settled once the page has reported one.
        state.menu.anchor.reposition();
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

  // fillLogin focuses every field it writes, and all of it happens in this one
  // synchronous call, so the flag covers exactly those focus events.
  state.filling = true;
  try {
    fillLogin(form, { username: credential.username, password: credential.password });
  } finally {
    state.filling = false;
  }
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

/**
 * The popover follows focus.
 *
 * Resting state is the icon alone on the field; focusing a credential field
 * opens the list of what can go in it, which is the moment the answer is
 * wanted, and leaving closes it again. Escape closes it without moving focus,
 * and it stays closed until the field is focused afresh.
 */
function observeFocus(): void {
  document.addEventListener('focusin', (event) => {
    const target = event.target;
    state.focused = target instanceof HTMLInputElement ? target : null;
    if (state.focused) void fieldFocused(state.focused, state.filling);
  });

  document.addEventListener('focusout', () => {
    // Where focus *went* is not known until the browser has moved it, and
    // clicking the icon or the list moves it into an overlay of ours.
    window.setTimeout(() => {
      if (focusIsOurs()) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && formForField(active)) return; // focusin has it
      state.focused = null;
      teardownMenu();
      placeButton();
    }, 0);
  });
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
  observeFocus();
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') teardownMenu();
  });
}

start();
