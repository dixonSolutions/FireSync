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
}

const nonce = new URL(location.href).searchParams.get('nonce') ?? '';
const list = document.getElementById('list') as HTMLUListElement;
const empty = document.getElementById('empty') as HTMLDivElement;

function post(message: Record<string, unknown>): void {
  parent.postMessage({ ...message, nonce }, '*');
}

function reportHeight(): void {
  post({ type: 'menu/resize', height: document.body.scrollHeight + 2 });
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

  (list.querySelector('button') as HTMLButtonElement | null)?.focus();
  reportHeight();
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as (MenuInit & { nonce?: string }) | null;
  if (!data || data.nonce !== nonce || data.type !== 'menu/init') return;
  render(data);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') post({ type: 'menu/close' });
});

reportHeight();

export {};
