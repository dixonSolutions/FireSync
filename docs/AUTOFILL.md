# Autofill

Chrome's save-password bubble and autofill dropdown are native browser UI.
`chrome.passwordsPrivate` and `chrome.autofillPrivate` are restricted to component
extensions shipped inside the browser, and no supported API lets an extension add an entry
to either. So FireSync draws its own. This document is how.

## Detection

`src/autofill/detector.ts`, in priority order:

**1. `autocomplete` tokens win outright.** `current-password`, `new-password`,
`one-time-code`, `username`, `email`. When a page bothers to set them they are
authoritative and cost nothing to honour.

**2. Structural position.** The username is the highest-scoring textual input *preceding*
the password field and sharing its form — not merely the first text input on the page. A
candidate that appears after the password is still considered (multi-step logins exist) but
must beat a preceding one outright.

**3. Token scoring** over `name`, `id`, `placeholder`, `aria-label`, `data-testid`, and the
associated label text — found via `aria-labelledby`, `label[for]`, an ancestor `<label>`, or
an immediately preceding `<span>`/`<div>`.

Three token sets do the work:

- **Username tokens**, word-bounded: `user`, `login`, `email`, `account`, `identifier`,
  `benutzer`, `usuario`, `utilisateur`, `correo`, …
- **Compound tokens**, matched anywhere, because languages that compound their nouns defeat
  word boundaries — `benutzername` contains neither a bounded `user` nor a bounded
  `benutzer`.
- **Negative tokens** — `search`, `q`, `captcha`, `coupon`, `promo`, `postal`, `phone`,
  `firstname`, `address`, `card`, `cvv`, `honeypot`, `bot-field`. A field matching these and
  nothing positive is out.

A field must also be *fillable*: not hidden, disabled, readonly, `aria-hidden`, or
`display:none`. Geometry is consulted only when the document actually has layout, so the
same code behaves correctly in a headless test DOM where every rectangle is zero-sized.

Open shadow roots are traversed recursively. Closed ones are, by definition, unreachable.

### Form classification

| Password fields | Classification |
|---|---|
| 0, with a one-time-code field | `totp` |
| 1 × `current-password` | `login` |
| 1 × `new-password` | `signup` |
| `current` + (`new` or `confirm`) | `change-password` |
| `new` and/or `confirm`, no `current` | `signup` |

This matters because FireSync must never fill a saved password into a `new-password` field —
that silently sets a user's new password to their old one.

A page with no password field at all still gets `findStandaloneUsernameField`, for the
"what's your email?" first step of a two-step login.

## The overlay

Two pieces, both in **closed** shadow roots attached to `document.documentElement`:

1. **An in-field button** — a small gradient square at the right edge of the field.
2. **The credential list** — an `<iframe>` pointing at `menu.html`, an extension page.

Why an iframe rather than shadow DOM alone: an extension page runs on the extension origin,
so the host page cannot read its DOM, cannot script it, and cannot see what is in it. The
iframe has no direct `chrome.*` access beyond `postMessage` back to the content script,
which means a compromised page cannot reach the privileged API even if it somehow got code
running inside the frame.

Messages between the frame and the content script carry a per-instance random nonce, and the
content script checks `event.origin` and `event.source` before reading anything.

`web_accessible_resources` uses `"use_dynamic_url": true`, so a site cannot probe a static
`chrome-extension://<id>/menu.html` URL to fingerprint FireSync users.

### Staying anchored

Real pages move underneath you. The overlay tracks its field with capture-phase `scroll`,
`resize`, a `ResizeObserver`, an `IntersectionObserver` to hide when the field scrolls out of
view, and a 500 ms interval as a backstop for layout changes none of those report. It hides
on blur, on Escape, and when the field's rectangle collapses to zero.

## Filling

Setting `input.value` directly is not enough. React tracks the previous value on the DOM
node and treats a direct assignment as a no-op, reverting the field on the next render. So
`src/autofill/filler.ts` calls the **native** value setter from the prototype descriptor and
then dispatches `input`, `change` and `keyup`, all `bubbles: true` and `composed: true`.

`test/detector.dom.test.ts` asserts the events actually fire and reach a document-level
listener.

## Capture and the save prompt

Credentials are captured into a short-lived per-tab buffer on any of: `submit`, Enter in a
password field, a click on a submit-ish element, or `pagehide`.

The prompt then fires on whichever of these happens first:

- the tab commits a navigation, or
- the password field disappears from the DOM — which is how XHR logins signal success, since
  they never navigate.

The background decides whether to prompt at all:

```
per-site "never save"?                    → silent
vault locked?                             → silent
same username, same password already?     → silent
same username, different password?        → prompt as UPDATE
otherwise                                 → prompt as SAVE
```

The bar itself is another extension-origin iframe, fixed to the top-right, offering
**Save** / **Never for this site** / dismiss.

## Matching

`src/match/uri.ts` decides whether a stored credential may be offered on a page. This is the
security boundary of the entire feature, so every rule fails closed.

| Strategy | Rule |
|---|---|
| `domain` (default) | Equal registrable domains (eTLD+1) via the Public Suffix List, plus a curated equivalent-domain list |
| `host` | Exact hostname |
| `startsWith` | Page URL starts with the stored URL |
| `exact` | Full URL equality |
| `regex` | User-supplied pattern; an invalid pattern matches nothing |
| `never` | Never offered |

Additional invariants across all strategies:

- Only `http:` and `https:` are considered at all.
- An **https-saved credential is never filled into an http page**. The reverse is an upgrade
  and is allowed.
- Hosts with no registrable domain — IP literals, `localhost` — require an exact host match.
- Matching is never substring-based. `test/uri.test.ts` covers `example.com.evil.net`,
  `notexample.com`, and `evil.co.uk` against `bank.co.uk` explicitly.

Results are ranked so the most specific credential is pre-selected: exact origin beats exact
host beats registrable domain.

## Per-site preferences

The "remembering preferences" half of the product. Stored per origin, unencrypted (none of
it is secret), and optionally synced through the private `firesync-prefs` collection.

```ts
{
  origin: 'https://example.com',
  neverSave: true,
  defaultCredentialId: '<id>',      // pre-select when several match
  autoFillOnLoad: false,
  inlineMenu: 'on' | 'button-only' | 'off',
  matchStrategy: 'domain' | 'host' | 'startsWith' | 'exact' | 'regex' | 'never',
  equivalentDomains: ['example.net'],
  updatedAt: 1735689600000
}
```

Unlike logins, preferences merge field-by-field across devices — they are small, independent,
per-origin values, and a user who sets "never save" on one machine expects it everywhere.

## Living with Chrome's own manager

There is no API to disable it. The policy files in `packaging/` set
`PasswordManagerEnabled: false`; without a policy, the onboarding page walks the user through
`chrome://settings/autofill`. Skipping this gives two prompts and two dropdowns on every
login form and is the most common "FireSync is broken" report.
