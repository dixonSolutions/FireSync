/**
 * The overlay layer: how FireSync draws UI on top of a page it does not trust.
 *
 * Chrome's own save-password bubble and autofill dropdown are native browser
 * UI. `chrome.passwordsPrivate` and `chrome.autofillPrivate` are restricted to
 * component extensions, so there is no supported way for FireSync to reuse
 * them. Everything the user sees is therefore drawn by us — the same approach
 * every third-party password manager takes.
 *
 * The rules that keep that safe:
 *
 *   - Every overlay lives in a **closed** shadow root, so page scripts cannot
 *     walk into it via `element.shadowRoot`.
 *   - The interactive part is an `<iframe>` pointing at an extension page, so
 *     it runs on the extension origin and the page cannot read its DOM.
 *   - That iframe talks only via `postMessage`, and every message is checked
 *     against the expected origin and a per-instance nonce.
 */

const HOST_ATTRIBUTE = 'data-firesync';

export interface OverlayHandle {
  host: HTMLElement;
  iframe: HTMLIFrameElement;
  shadow: ShadowRoot;
  nonce: string;
  destroy(): void;
  post(message: unknown): void;
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Create a closed-shadow host containing an extension-page iframe. */
export function createOverlay(options: {
  page: string;
  kind: string;
  style: Partial<CSSStyleDeclaration>;
  onMessage?: (message: unknown) => void;
}): OverlayHandle {
  const host = document.createElement('div');
  host.setAttribute(HOST_ATTRIBUTE, options.kind);
  Object.assign(host.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    zIndex: '2147483647',
    border: '0',
    padding: '0',
    margin: '0',
    colorScheme: 'normal',
    ...options.style,
  });

  const shadow = host.attachShadow({ mode: 'closed' });
  const nonce = randomNonce();

  const iframe = document.createElement('iframe');
  const url = new URL(chrome.runtime.getURL(options.page));
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('pageUrl', location.href);
  iframe.src = url.toString();
  iframe.setAttribute('allowtransparency', 'true');
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('title', 'FireSync');
  Object.assign(iframe.style, {
    border: '0',
    width: '100%',
    height: '100%',
    background: 'transparent',
    colorScheme: 'normal',
  });

  shadow.append(iframe);
  document.documentElement.append(host);

  const extensionOrigin = new URL(chrome.runtime.getURL('/')).origin;
  const listener = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) return;
    if (event.origin !== extensionOrigin) return;
    const data = event.data as { nonce?: string } | null;
    if (!data || data.nonce !== nonce) return;
    options.onMessage?.(data);
  };
  window.addEventListener('message', listener);

  return {
    host,
    iframe,
    shadow,
    nonce,
    destroy() {
      window.removeEventListener('message', listener);
      host.remove();
    },
    post(message: unknown) {
      iframe.contentWindow?.postMessage({ ...(message as object), nonce }, extensionOrigin);
    },
  };
}

/** A live anchor: `detach` stops tracking, `reposition` re-runs the placement. */
export interface Anchor {
  detach(): void;
  reposition(): void;
}

/**
 * Keep an overlay glued to a field through scrolling, resizing, and layout
 * changes.
 */
export function anchorTo(
  handle: OverlayHandle,
  target: HTMLElement,
  place: (rect: DOMRect, host: HTMLElement) => void,
): Anchor {
  const reposition = (): void => {
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      handle.host.style.display = 'none';
      return;
    }
    handle.host.style.display = '';
    place(rect, handle.host);
  };

  reposition();

  const scrollListener = (): void => reposition();
  window.addEventListener('scroll', scrollListener, { capture: true, passive: true });
  window.addEventListener('resize', scrollListener, { passive: true });

  const resizeObserver =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reposition) : null;
  resizeObserver?.observe(target);

  const intersectionObserver =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(
          (entries) => {
            const entry = entries[0];
            if (entry && !entry.isIntersecting) handle.host.style.display = 'none';
            else reposition();
          },
          { threshold: 0 },
        )
      : null;
  intersectionObserver?.observe(target);

  const interval = window.setInterval(reposition, 500);

  return {
    reposition,
    detach() {
      window.removeEventListener('scroll', scrollListener, { capture: true });
      window.removeEventListener('resize', scrollListener);
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      window.clearInterval(interval);
    },
  };
}

/** Place the small in-field button at the right edge of a field. */
export function placeInFieldButton(rect: DOMRect, host: HTMLElement): void {
  const size = Math.min(22, Math.max(14, rect.height - 8));
  host.style.width = `${size}px`;
  host.style.height = `${size}px`;
  host.style.left = `${rect.right + window.scrollX - size - 6}px`;
  host.style.top = `${rect.top + window.scrollY + (rect.height - size) / 2}px`;
}

/**
 * Where the popover sits relative to the field, and where its caret points.
 *
 * The caret is drawn inside the iframe — the host is just a box holding it —
 * so the side and the caret offset have to be handed to the menu page rather
 * than applied here.
 */
export interface MenuPlacement {
  side: 'above' | 'below';
  /** Where the caret points, as an offset from the popover's own left edge. */
  caret: number;
}

/**
 * How close to a viewport edge the popover is allowed to come.
 *
 * The gap between the field and the card itself is *not* here: the host box is
 * flush against the field and menu.html pads the caret's side by 8px, so the
 * caret and the space it needs are described in one place.
 */
const VIEWPORT_MARGIN = 8;
/** Keeps the caret off the popover's rounded corners. */
const CARET_INSET = 18;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * Place the credential list against a field.
 *
 * It is centred on the field and sits below it, because that is where a field's
 * own suggestions appear and it is the one position that does not depend on
 * which way the page happens to be laid out. Everything after that is the page
 * running out of room: the popover slides back inside whichever viewport edge
 * it overruns, and flips above the field when there is no room below it and
 * more room above. The caret keeps pointing at the field through all of it, so
 * a shifted popover still says which field it belongs to.
 */
export function placeMenu(rect: DOMRect, host: HTMLElement): MenuPlacement {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;

  const width = Math.min(
    Math.max(260, Math.min(rect.width, 420)),
    Math.max(180, viewportWidth - VIEWPORT_MARGIN * 2),
  );
  host.style.width = `${width}px`;

  // Set by the menu page's own resize report; 0 on the first pass, which just
  // means the first placement is provisional and the report re-runs this.
  const height = host.offsetHeight;

  const centre = rect.left + rect.width / 2;
  const left = clamp(centre - width / 2, VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - width);

  const roomBelow = viewportHeight - rect.bottom - VIEWPORT_MARGIN;
  const roomAbove = rect.top - VIEWPORT_MARGIN;
  const side: 'above' | 'below' =
    height <= roomBelow || roomBelow >= roomAbove ? 'below' : 'above';

  host.style.left = `${left + window.scrollX}px`;
  host.style.top = `${(side === 'below' ? rect.bottom : rect.top - height) + window.scrollY}px`;

  return { side, caret: clamp(centre - left, CARET_INSET, width - CARET_INSET) };
}

/**
 * Whether a node is one of our overlay hosts.
 *
 * Focus landing inside a closed shadow root is reported to the page as the
 * host element, so this is how the content script tells "the user clicked our
 * popover" from "the user clicked away".
 */
export function isOverlayHost(node: Node | null): boolean {
  return node instanceof Element && node.hasAttribute(HOST_ATTRIBUTE);
}

/** Remove any FireSync overlay left behind by a previous injection. */
export function removeStaleOverlays(): void {
  for (const node of Array.from(document.querySelectorAll(`[${HOST_ATTRIBUTE}]`))) {
    node.remove();
  }
}
