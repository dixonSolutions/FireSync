/** The tiny in-field FireSync button. Its only job is to report a click. */
const nonce = new URL(location.href).searchParams.get('nonce') ?? '';

document.getElementById('open')?.addEventListener('click', () => {
  parent.postMessage({ type: 'button/click', nonce }, '*');
});

export {};
