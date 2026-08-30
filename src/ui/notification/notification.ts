/** The save/update prompt. FireSync's replacement for Chrome's native bubble. */

interface BarInit {
  type: 'bar/init';
  mode: 'save' | 'update';
  username: string;
  origin: string;
}

const nonce = new URL(location.href).searchParams.get('nonce') ?? '';
const title = document.getElementById('title') as HTMLHeadingElement;
const detail = document.getElementById('detail') as HTMLParagraphElement;
const save = document.getElementById('save') as HTMLButtonElement;

function post(message: Record<string, unknown>): void {
  parent.postMessage({ ...message, nonce }, '*');
}

function reportHeight(): void {
  post({ type: 'bar/resize', height: document.body.scrollHeight + 4 });
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as (BarInit & { nonce?: string }) | null;
  if (!data || data.nonce !== nonce || data.type !== 'bar/init') return;

  const isUpdate = data.mode === 'update';
  title.textContent = isUpdate ? 'Update this password?' : 'Save this login?';
  save.textContent = isUpdate ? 'Update' : 'Save';
  detail.textContent = `${data.username || '(no username)'} — ${data.origin}`;
  reportHeight();
});

save.addEventListener('click', () => post({ type: 'bar/save' }));
document.getElementById('never')?.addEventListener('click', () => post({ type: 'bar/never' }));
document.getElementById('dismiss')?.addEventListener('click', () => post({ type: 'bar/dismiss' }));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') post({ type: 'bar/dismiss' });
});

reportHeight();

export {};
