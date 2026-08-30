/**
 * Form and field detection.
 *
 * Chrome gives extensions no access to its own field classifier, so FireSync
 * has to do this itself. The strategy, in priority order:
 *
 *   1. `autocomplete` tokens, when the page bothered to set them. These are
 *      authoritative and cost nothing to honour.
 *   2. Structural position: the username is the labelled text input closest
 *      *above* the password field, not merely the first text input on the page.
 *   3. Token scoring over name / id / placeholder / aria-label / label text,
 *      with an explicit negative list so search boxes and coupon codes never
 *      win.
 *
 * Everything here is pure DOM and therefore unit-testable; the tests in
 * `test/detector.dom.test.ts` run it against real markup from sites that are
 * historically awkward (multi-step logins, signup forms, change-password
 * forms, shadow DOM, hidden honeypots).
 */

export type FieldKind =
  | 'username'
  | 'email'
  | 'current-password'
  | 'new-password'
  | 'confirm-password'
  | 'totp'
  | 'unknown';

export type FormKind = 'login' | 'signup' | 'change-password' | 'totp' | 'unknown';

export interface DetectedForm {
  /** The owning <form>, or null for form-less login widgets. */
  form: HTMLFormElement | null;
  kind: FormKind;
  username: HTMLInputElement | null;
  currentPassword: HTMLInputElement | null;
  newPassword: HTMLInputElement | null;
  confirmPassword: HTMLInputElement | null;
  totp: HTMLInputElement | null;
  submit: HTMLElement | null;
  /** Every field we considered, for diagnostics in the options page. */
  fields: { element: HTMLInputElement; kind: FieldKind; score: number }[];
}

const USERNAME_TOKENS =
  /(^|[^a-z])(user|username|login|log[-_]?in|email|e[-_]?mail|account|identifier|ident|userid|user[-_]?name|signin|benutzer|usuario|utilisateur|correo|courriel)([^a-z]|$)/i;

/**
 * Languages that compound their nouns defeat the word-boundary rule above:
 * "benutzername" contains neither a bounded "user" nor a bounded "benutzer".
 * These are matched anywhere in the string.
 */
const USERNAME_COMPOUNDS =
  /(username|userid|loginname|benutzername|benutzerkennung|gebruikersnaam|nomeutente|nomdutilisateur|nombredeusuario|utilisateur|usuario|correo)/i;

/** Whether a field's text looks like a username/email field in any language. */
export function looksLikeUsername(text: string): boolean {
  return USERNAME_TOKENS.test(text) || USERNAME_COMPOUNDS.test(text);
}

const NEGATIVE_TOKENS =
  /(search|query|q$|captcha|coupon|promo|voucher|discount|zip|postal|postcode|phone|tel|mobile|firstname|lastname|surname|given|family|street|address|city|state|country|company|organisation|organization|comment|message|subject|title|amount|quantity|card|cvv|cvc|expiry|expiration|otp[-_]?url|honeypot|bot[-_]?field)/i;

const TOTP_TOKENS =
  /(otp|2fa|two[-_]?factor|totp|auth[-_]?code|verification[-_]?code|security[-_]?code|one[-_]?time)/i;

const NEW_PASSWORD_TOKENS = /(new[-_]?pass|create[-_]?pass|set[-_]?pass|register|signup|sign[-_]?up|choose[-_]?pass)/i;
const CONFIRM_PASSWORD_TOKENS = /(confirm|repeat|retype|re[-_]?enter|verify|again|_2$|2$)/i;
const CURRENT_PASSWORD_TOKENS = /(current[-_]?pass|old[-_]?pass|existing[-_]?pass)/i;

const SUBMIT_TOKENS = /(log[-_ ]?in|sign[-_ ]?in|submit|continue|next|anmelden|entrar|connexion|iniciar)/i;

/** Attributes worth reading when scoring a field. */
function fieldText(input: HTMLInputElement): string {
  const parts = [
    input.getAttribute('name'),
    input.getAttribute('id'),
    input.getAttribute('placeholder'),
    input.getAttribute('aria-label'),
    input.getAttribute('data-testid'),
    input.getAttribute('autocomplete'),
    labelTextFor(input),
  ];
  return parts.filter(Boolean).join(' ');
}

/** The visible label text associated with an input, if we can find one. */
export function labelTextFor(input: HTMLInputElement): string {
  const doc = input.ownerDocument;

  const labelledBy = input.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }

  if (input.id) {
    const explicit = doc.querySelector(`label[for="${cssEscape(input.id)}"]`);
    if (explicit?.textContent) return explicit.textContent.trim();
  }

  const ancestor = input.closest('label');
  if (ancestor?.textContent) return ancestor.textContent.trim();

  // A label rendered as a sibling <span>/<div> immediately before the input.
  const previous = input.previousElementSibling;
  if (previous && /^(span|div|p|label)$/i.test(previous.tagName) && previous.textContent) {
    return previous.textContent.trim().slice(0, 80);
  }

  return '';
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * Whether a field is a real, fillable field.
 *
 * In a headless/test DOM every element reports a zero-sized rect, which would
 * make everything "invisible". So geometry is only consulted when the document
 * actually has layout.
 */
export function isFillable(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly) return false;
  if (input.type === 'hidden') return false;
  if (input.hidden) return false;
  if (input.getAttribute('aria-hidden') === 'true') return false;

  const view = input.ownerDocument?.defaultView;
  const style = view?.getComputedStyle?.(input);
  if (style) {
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.opacity === '0') return false;
  }

  const documentHasLayout =
    (input.ownerDocument?.documentElement?.getBoundingClientRect?.().width ?? 0) > 0;
  if (documentHasLayout) {
    const rect = input.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
  }

  return true;
}

/** All inputs under a root, descending into open shadow roots. */
export function collectInputs(root: Document | ShadowRoot | Element): HTMLInputElement[] {
  const found: HTMLInputElement[] = [];
  const visit = (node: Document | ShadowRoot | Element): void => {
    const inputs = node.querySelectorAll?.('input, select');
    if (inputs) {
      for (const element of Array.from(inputs)) {
        if (element instanceof (element.ownerDocument.defaultView?.HTMLInputElement ?? Object)) {
          found.push(element as HTMLInputElement);
        } else if (element.tagName === 'INPUT') {
          found.push(element as HTMLInputElement);
        }
      }
    }
    const all = node.querySelectorAll?.('*');
    if (all) {
      for (const element of Array.from(all)) {
        const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (shadow) visit(shadow);
      }
    }
  };
  visit(root);
  return found;
}

const PASSWORD_TYPES = new Set(['password']);
const TEXTUAL_TYPES = new Set(['text', 'email', 'tel', 'search', 'url', '']);

/** Classify a single input in isolation. */
export function classifyField(input: HTMLInputElement): { kind: FieldKind; score: number } {
  const autocomplete = (input.getAttribute('autocomplete') ?? '').toLowerCase();
  const type = (input.getAttribute('type') ?? 'text').toLowerCase();
  const text = fieldText(input);

  // 1. Explicit autocomplete tokens win outright.
  if (autocomplete.includes('current-password')) return { kind: 'current-password', score: 100 };
  if (autocomplete.includes('new-password')) return { kind: 'new-password', score: 100 };
  if (autocomplete.includes('one-time-code')) return { kind: 'totp', score: 100 };
  if (autocomplete.includes('username')) return { kind: 'username', score: 100 };
  if (autocomplete.includes('email')) return { kind: 'email', score: 90 };

  if (PASSWORD_TYPES.has(type)) {
    if (CONFIRM_PASSWORD_TOKENS.test(text)) return { kind: 'confirm-password', score: 70 };
    if (NEW_PASSWORD_TOKENS.test(text)) return { kind: 'new-password', score: 70 };
    if (CURRENT_PASSWORD_TOKENS.test(text)) return { kind: 'current-password', score: 75 };
    return { kind: 'current-password', score: 50 };
  }

  if (!TEXTUAL_TYPES.has(type)) return { kind: 'unknown', score: 0 };

  if (TOTP_TOKENS.test(text)) return { kind: 'totp', score: 60 };

  if (NEGATIVE_TOKENS.test(text) && !looksLikeUsername(text)) {
    return { kind: 'unknown', score: 0 };
  }

  if (type === 'email') return { kind: 'email', score: 65 };
  if (looksLikeUsername(text)) return { kind: 'username', score: 60 };

  return { kind: 'unknown', score: 5 };
}

/** Decide the overall purpose of a form from the password fields present. */
export function classifyFormKind(
  passwords: HTMLInputElement[],
  hasTotp: boolean,
): FormKind {
  const kinds = passwords.map((input) => classifyField(input).kind);
  const newCount = kinds.filter((kind) => kind === 'new-password').length;
  const confirmCount = kinds.filter((kind) => kind === 'confirm-password').length;
  const currentCount = kinds.filter((kind) => kind === 'current-password').length;

  if (passwords.length === 0) return hasTotp ? 'totp' : 'unknown';
  if (passwords.length === 1) return currentCount === 1 && newCount === 0 ? 'login' : 'signup';
  if (currentCount >= 1 && (newCount >= 1 || confirmCount >= 1)) return 'change-password';
  if (newCount >= 1 || confirmCount >= 1) return 'signup';
  return 'login';
}

/**
 * Find the username field for a password field: the highest-scoring textual
 * input that appears *before* it in document order and shares a form.
 */
export function findUsernameFor(
  password: HTMLInputElement,
  candidates: HTMLInputElement[],
): HTMLInputElement | null {
  const sameForm = candidates.filter((input) => input.form === password.form);
  const pool = sameForm.length ? sameForm : candidates;

  let best: { element: HTMLInputElement; score: number } | null = null;
  for (const input of pool) {
    if (input === password) continue;
    const position = password.compareDocumentPosition(input);
    const isBefore = (position & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    const { kind, score } = classifyField(input);
    if (kind !== 'username' && kind !== 'email') continue;
    // A field after the password is usually a second step or a confirm-email;
    // still allowed, but it must beat a preceding candidate outright.
    const adjusted = isBefore ? score + 10 : score - 20;
    if (!best || adjusted > best.score) best = { element: input, score: adjusted };
  }
  return best?.element ?? null;
}

/** The element that most likely submits this form. */
export function findSubmitFor(
  form: HTMLFormElement | null,
  password: HTMLInputElement | null,
): HTMLElement | null {
  const scope: ParentNode | null = form ?? password?.ownerDocument ?? null;
  if (!scope) return null;

  const explicit = scope.querySelector?.(
    'button[type="submit"], input[type="submit"], input[type="image"]',
  );
  if (explicit) return explicit as HTMLElement;

  const buttons = Array.from(scope.querySelectorAll?.('button, [role="button"]') ?? []);
  for (const button of buttons) {
    if (SUBMIT_TOKENS.test(button.textContent ?? '')) return button as HTMLElement;
  }
  return (buttons[0] as HTMLElement | undefined) ?? null;
}

/**
 * Detect every credential-bearing form under `root`.
 *
 * Groups by owning `<form>`; inputs with no form are grouped together, which is
 * how most single-page-app login widgets are built.
 */
export function detectForms(root: Document | ShadowRoot | Element): DetectedForm[] {
  const inputs = collectInputs(root).filter(isFillable);
  if (!inputs.length) return [];

  const groups = new Map<HTMLFormElement | null, HTMLInputElement[]>();
  for (const input of inputs) {
    const key = input.form ?? null;
    const bucket = groups.get(key);
    if (bucket) bucket.push(input);
    else groups.set(key, [input]);
  }

  const results: DetectedForm[] = [];
  for (const [form, groupInputs] of groups) {
    const classified = groupInputs.map((element) => ({ element, ...classifyField(element) }));
    const passwords = groupInputs.filter(
      (input) => (input.getAttribute('type') ?? '').toLowerCase() === 'password',
    );
    const totp = classified.find((field) => field.kind === 'totp')?.element ?? null;

    if (!passwords.length && !totp) continue;

    const currentPassword =
      classified.find((field) => field.kind === 'current-password')?.element ?? null;
    const newPassword = classified.find((field) => field.kind === 'new-password')?.element ?? null;
    const confirmPassword =
      classified.find((field) => field.kind === 'confirm-password')?.element ?? null;

    const anchor = currentPassword ?? newPassword ?? passwords[0] ?? null;
    const username = anchor ? findUsernameFor(anchor, groupInputs) : null;

    results.push({
      form,
      kind: classifyFormKind(passwords, totp !== null),
      username,
      currentPassword,
      newPassword,
      confirmPassword,
      totp,
      submit: findSubmitFor(form, anchor),
      fields: classified,
    });
  }

  return results;
}

/**
 * A form-less page can still be a login step (a "what's your email?" screen).
 * This finds the field to anchor the inline menu to when `detectForms` finds
 * nothing.
 */
export function findStandaloneUsernameField(
  root: Document | ShadowRoot | Element,
): HTMLInputElement | null {
  const candidates = collectInputs(root)
    .filter(isFillable)
    .map((element) => ({ element, ...classifyField(element) }))
    .filter((field) => field.kind === 'username' || field.kind === 'email')
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.element ?? null;
}
