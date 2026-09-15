/**
 * The credential picker rendered inside the inline menu iframe.
 *
 * It runs on the extension origin, so the host page cannot read it. It receives
 * only usernames and origins — never a password — and asks the content script
 * to perform the fill by id.
 */

interface MenuInit {
  type: 'menu/init';
  matches: { id: string; username: string; origin: string }[];
  unlocked: boolean;
  pageUrl: string;
  /**
   * Whether to move focus into the list.
   *
   * False when the popover opened because a field was focused: the user is
   * about to type into that field, and taking focus off it to land on a list
   * they did not ask for makes the page unusable. True when they reached for
   * the popover itself.
   */
  focusList: boolean;
}

/** Where the caret points, sent by the content script as the popover moves. */
interface MenuPlace {
  type: 'menu/place';
  side: 'above' | 'below';
  caret: number;
}

type Inbound = MenuInit | MenuPlace | { type: 'menu/focus' };

const nonce = new URL(location.href).searchParams.get('nonce') ?? '';
const list = document.getElementById('list') as HTMLUListElement;
const empty = document.getElementById('empty') as HTMLDivElement;
const caret = document.getElementById('caret') as HTMLDivElement;

function post(message: Record<string, unknown>): void {
  parent.postMessage({ ...message, nonce }, '*');
}

function reportHeight(): void {
  post({ type: 'menu/resize', height: document.body.scrollHeight + 2 });
}

/** The caret is a square rotated about its own centre, so back off half of it. */
function place(message: MenuPlace): void {
  document.body.classList.toggle('above', message.side === 'above');
  document.body.classList.toggle('below', message.side === 'below');
  caret.style.left = `${message.caret - 5}px`;
}

function focusList(): void {
  (list.querySelector('button') as HTMLButtonElement | null)?.focus();
}

function render(init: MenuInit): void {
  list.replaceChildren();

  if (!init.unlocked) {
    empty.hidden = false;
    empty.textContent = 'FireSync is locked. Open the toolbar icon to unlock.';
    reportHeight();
    return;
  }
  if (!init.matches.length) {
    empty.hidden = false;
    empty.textContent = 'No saved logins for this site.';
    reportHeight();
    return;
  }

  empty.hidden = true;
  for (const match of init.matches) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';

    const user = document.createElement('span');
    user.className = 'user';
    user.textContent = match.username || '(no username)';

    const origin = document.createElement('span');
    origin.className = 'origin';
    origin.textContent = match.origin;

    button.append(user, origin);
    button.addEventListener('click', () => post({ type: 'menu/fill', id: match.id }));
    item.append(button);
    list.append(item);
  }

  if (init.focusList) focusList();
  reportHeight();
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as (Inbound & { nonce?: string }) | null;
  if (!data || data.nonce !== nonce) return;
  if (data.type === 'menu/init') render(data);
  else if (data.type === 'menu/place') place(data);
  else if (data.type === 'menu/focus') focusList();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') post({ type: 'menu/close' });
});

reportHeight();

export {};
