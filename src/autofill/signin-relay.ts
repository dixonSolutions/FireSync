/**
 * A tiny content script that runs only on the OAuth success page.
 *
 * Detecting the redirect with `chrome.tabs.onUpdated` alone means one mechanism
 * standing between a user and a working sign-in, and if it does not fire — a
 * dormant worker that is not woken, a navigation reported without a URL, a
 * fragment-only redirect — the flow simply stops with no explanation.
 *
 * This is an independent second path. It runs on the redirect page itself, so
 * it cannot miss a navigation it *is*, and reports the URL from inside the
 * page. Reporting the same redirect twice is harmless: the coordinator finishes
 * the flow on the first one and ignores the rest.
 */

const SUCCESS_PATH = /^\/oauth\/success\//;

if (SUCCESS_PATH.test(location.pathname)) {
  chrome.runtime
    .sendMessage({ type: 'signin/redirect', url: location.href })
    .catch(() => {
      // The extension may be reloading. The tabs listener is the other path.
    });
}

export {};
