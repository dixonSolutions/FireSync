/**
 * RFC 8252 loopback OAuth.
 *
 * A native app is allowed to use `http://127.0.0.1:<random port>/` as its
 * redirect URI, which is what makes browser-based sign-in possible for a
 * process that has no web origin of its own. The listener is bound to the
 * loopback interface, accepts exactly one request, and closes.
 *
 * **This only works with an OAuth client whose registration includes a loopback
 * redirect.** FireSync currently borrows a Mozilla public client id and must use
 * that client's own registered redirect, so this path is shipped but dormant.
 * See docs/PROTOCOL.md#oauth-client-identity.
 */

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { platform } from 'node:os';

const SUCCESS_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>FireSync</title>
<style>
  body { font: 15px system-ui, sans-serif; display: grid; place-items: center;
         height: 100vh; margin: 0; background: #141419; color: #f2f2f5; }
  .card { text-align: center; }
  .mark { width: 48px; height: 48px; border-radius: 14px; margin: 0 auto 16px;
          background: linear-gradient(135deg, #ff8a3d, #ff3d7f 45%, #9b5de5); }
</style>
<div class="card">
  <div class="mark"></div>
  <h1>You're signed in</h1>
  <p>You can close this tab and go back to your browser.</p>
</div>`;

/** Open a URL in the user's default browser. */
export function openBrowser(url) {
  const [command, args] =
    platform() === 'darwin'
      ? ['open', [url]]
      : platform() === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(command, args, () => {
    /* the user can always paste the URL themselves */
  });
}

/**
 * Start a one-shot loopback listener, open the authorization URL, and resolve
 * with the `code`/`state` the provider redirects back with.
 */
export function loopbackAuthorize({
  authorizationUrl,
  redirectPath = '/',
  timeoutMs = 300_000,
  open = openBrowser,
} = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (url.pathname !== redirectPath) {
        response.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(SUCCESS_PAGE);

      finish(
        error
          ? new Error(`authorization failed: ${error}`)
          : !code || !state
            ? new Error('redirect carried no authorization code')
            : null,
        { code, state },
      );
    });

    let settled = false;
    const timer = setTimeout(() => {
      const timeout = new Error('timed out waiting for the authorization redirect');
      timeout.code = 'timeout';
      finish(timeout);
    }, timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(value);
    }

    server.on('error', finish);

    // Port 0 asks the OS for a free one; binding to 127.0.0.1 keeps it off the
    // network entirely.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const target = new URL(authorizationUrl);
      target.searchParams.set('redirect_uri', `http://127.0.0.1:${port}${redirectPath}`);
      open(target.toString());
    });
  });
}
