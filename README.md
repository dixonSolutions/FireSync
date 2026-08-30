<p align="center">
  <img src="assets/banner.png" alt="FireSync — take your Mozilla vault to any Chromium browser" width="100%">
</p>

<p align="center">
  <strong>Take your Mozilla vault — passwords and autofill — to any Chromium browser.</strong><br>
  Sign in with your Mozilla account, keep everything in step with Firefox, and hold the keys
  yourself. End-to-end encrypted with your own Sync key. There is no FireSync server.
</p>

<p align="center">
  <a href="https://dixonsolutions.github.io/FireSync/"><strong>Download &amp; install</strong></a> ·
  <a href="https://github.com/dixonSolutions/FireSync/releases">Releases</a> ·
  <a href="docs/INSTALL.md">Install guide</a> ·
  <a href="docs/FAQ.md">FAQ</a> ·
  <a href="NOTICE.md">Notice</a>
</p>

## Supported browsers

| Browser | | How to install |
|---|---|---|
| **Chromium** | works | Load unpacked, drop in the CRX, `--load-extension`, or policy |
| **Brave · Vivaldi · ungoogled-chromium** | works | Same as Chromium |
| **Microsoft Edge** | works | Policy with self-hosting, or load unpacked |
| **Google Chrome** | conditional | Developer mode, or enterprise policy on a **managed** browser |

Stock, unmanaged Chrome refuses self-hosted extensions — it requires a Web Store-issued
publisher proof inside the CRX. That is a Chrome policy, not a packaging mistake, and
Chromium enforces none of it. Details and every workaround:
[docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).

## What this is

Firefox Sync is an open, documented, end-to-end encrypted protocol. FireSync speaks it
directly from a Chromium extension, so the logins you save in Firefox appear in Chrome and
the logins you save in Chrome appear back in Firefox — with no bridge service, no export
file, and no third party holding your vault.

- **Mozilla account sign-in**, including TOTP, emailed confirmation codes, and Mozilla's
  new-device sign-in unblock flow.
- **Two-way sync** of the `passwords` and `addresses` collections over Sync 1.5, with
  batched uploads, `X-If-Unmodified-Since` preconditions, and last-writer-wins conflict
  resolution keyed on `timePasswordChanged` — the same rule Firefox itself uses.
- **Autofill, save prompts and per-site preferences**, drawn by FireSync itself because
  Chrome does not let extensions reuse its native ones (see [why](#the-two-hard-limits)).
- **A local vault encrypted at rest** with a passphrase that never leaves the device, and
  auto-locking that actually clears the key from memory.
- **An optional local bridge** that imports your Firefox logins straight off disk — no
  Mozilla account, no network — plus OS-keychain storage for the vault key.
- **Off-store distribution**: a signed CRX, a self-hosted update manifest, and ready-made
  policy files for Linux, Windows and macOS.

## The limit worth knowing up front

**You cannot inject into Chrome's own password UI.** `chrome.passwordsPrivate` and
`chrome.autofillPrivate` are restricted to component extensions shipped inside the browser.
There is no supported way to add an entry to the native save-password bubble or the autofill
dropdown. FireSync therefore draws its own — an in-field button, a credential list, and a
save/update bar — exactly as Bitwarden and 1Password do, and for exactly the same reason.

The practical consequence: turn Chrome's built-in manager off at
`chrome://settings/autofill`, or deploy the policy files in `packaging/`, which do it for
you. Leave it on and every login form gives you two prompts and two dropdowns.

## Quick start

**Just want to use it?** Grab a build from
<https://dixonsolutions.github.io/FireSync/> — the `.crx` for Chromium, the `.zip` for
everywhere including stock Chrome. Step-by-step: [docs/INSTALL.md](docs/INSTALL.md).

**Building from source:**

```bash
git clone <this repo> firesync && cd firesync
npm install
npm run assets      # rasterise the icons with headless Chrome
npm run build       # bundle into dist/
npm test            # 355 unit + integration tests, no network needed
```

Then load it — **Chromium (or Brave, Vivaldi, ungoogled-chromium) is the smoothest path**:

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and
   select the `dist/` directory. On Chromium you can also just drop the CRX onto that page;
   on stock Chrome you cannot — see [the matrix](docs/DISTRIBUTION.md#the-matrix).
2. FireSync opens its setup page. Choose a passphrase for the local vault, then connect
   your Mozilla account.
3. Turn off Chrome's own password manager at `chrome://settings/autofill` so the two do not
   both offer to save.

To produce a signed, self-hosted build instead:

```bash
npm run release     # typecheck + test + build + sign
# → build/firesync-0.1.0.crx, build/update.xml, build/extension-id.txt
```

Optionally install the local bridge, which adds Firefox profile import and OS-keychain
storage for the vault key:

```bash
cd bridge && ./install.sh <extension-id>   # id from chrome://extensions
```

## How it fits together

```
 Chrome page                    FireSync                        Mozilla
┌───────────────┐   overlay   ┌──────────────────┐   HTTPS   ┌────────────────────┐
│ login form    │◀───────────▶│ content script   │           │ accounts.firefox   │
│ (hostile JS)  │             │ detector/filler  │           │ .com   (sign-in)   │
└───────────────┘             └────────▲─────────┘           └─────────┬──────────┘
                                       │ messages                      │ OAuth
                              ┌────────┴─────────┐            ┌────────▼──────────┐
                              │ service worker   │───────────▶│ token.services    │
                              │ vault · sync15   │            │ .mozilla.com      │
                              │ fxa   · prefs    │            └────────┬──────────┘
                              └────────┬─────────┘                     │ Hawk
                        chrome.storage │                      ┌────────▼──────────┐
                        local(sealed)  │                      │ Sync 1.5 storage  │
                        session(keys)  ▼                      │ (AES-CBC + HMAC)  │
                                                              └───────────────────┘
```

Long version, with the exact protocol steps: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
and [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Documentation

| Document | What is in it |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layer-by-layer design, module map, data flow, service-worker lifecycle |
| [PROTOCOL.md](docs/PROTOCOL.md) | Every FxA and Sync 1.5 request, key derivation, record formats, the OAuth client-id problem |
| [SECURITY.md](docs/SECURITY.md) | Threat model, key hierarchy, what is stored where, known weaknesses |
| [AUTOFILL.md](docs/AUTOFILL.md) | Field detection heuristics, overlay design, capture and save flow |
| [BRIDGE.md](docs/BRIDGE.md) | The optional native host: local Firefox import, keychain, loopback OAuth |
| [DISTRIBUTION.md](docs/DISTRIBUTION.md) | Off-store install per platform, signing, auto-update, policy files |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Build, debug, add an engine, project conventions |
| [TESTING.md](docs/TESTING.md) | Test strategy, the fake Sync server, what is deliberately untested |
| [ROADMAP.md](docs/ROADMAP.md) | What is done, what is next, what is deliberately out of scope |
| [INSTALL.md](docs/INSTALL.md) | Installing on every browser, first run, updates, uninstalling |
| [FAQ.md](docs/FAQ.md) | Short answers to the questions this design invites |

## Status

Alpha. The protocol layers are complete and covered end to end against an in-memory Sync
server; they have not been exercised against a large real account. Before you point this at
an account you care about, read [docs/TESTING.md](docs/TESTING.md#before-you-trust-it) — it
tells you how to test safely with a throwaway Mozilla account.

Known gaps, stated plainly:

- **Credit cards are read-only and off by default.** Firefox also protects card numbers
  with an OS keystore, and the payload schema has changed more than once. FireSync will
  never write to that collection until a real account has been observed round-tripping.
- **The OAuth client id is borrowed.** Mozilla has no self-serve registration for
  third-party Sync clients, so FireSync reuses a public Mozilla client id the way every
  other third-party client does. It works; it is unsanctioned; it is configuration rather
  than a constant so it can be changed. The [local bridge](docs/BRIDGE.md) exists partly as
  insurance: importing from a Firefox profile on disk depends on none of this. See
  [docs/PROTOCOL.md](docs/PROTOCOL.md#oauth-client-identity).
- **Bookmarks, history, tabs and forms are not synced.** Chrome has no comparable surface
  for most of them and the ones it does have are better served by other tools.

## Updates

Chrome only auto-updates extensions it manages — a policy-installed build, or one from the
Web Store. An unpacked or drag-installed build never updates itself, and no extension can
install a new version of itself; Chrome closes that hole deliberately.

So FireSync ships its own update engine: it checks a small release manifest on a timer,
badges the toolbar icon, and offers a download link. **On by default**, configurable in
Settings → Updates to manual or off, with the manifest URL repointable for forks and
self-hosting. "Off" is absolute — it makes no requests at all, and the Check now button will
not override it.

## Licence and affiliation

MIT.

FireSync is an independent **hobby project**. It is not produced, sponsored, endorsed or
condoned by Mozilla Foundation, Mozilla Corporation, Google LLC or any of their affiliates,
and it is **not a competing product** — there is nothing to buy, no telemetry, and no
revenue. Its purpose is to let someone who already uses Firefox Sync reach their own data,
with their own credentials, from a second browser they also use.

No Mozilla or Google source code is included; the protocol implementation was written from
public documentation and published RFCs. "Mozilla", "Firefox", "Firefox Sync", "Chrome" and
"Chromium" are trademarks of their respective owners, used here only nominatively.

If Mozilla, Google or anyone else has a concern with this project, **please get in touch
before filing a takedown** — we will reply quickly and comply with a reasonable request,
including removing functionality or taking it down. The full statement is in
[NOTICE.md](NOTICE.md).
