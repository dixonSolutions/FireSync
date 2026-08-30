# Security

FireSync holds every password its user has. This document states what it defends against,
what it does not, and where the sharp edges are.

## Reporting a vulnerability

Open a **private** security advisory on the repository, or email the maintainers. Please do
not open a public issue for anything that would let someone read another person's vault.
Include the version, the platform, and a minimal reproduction. There is no bounty; there is
a fast acknowledgement.

---

## Key hierarchy

FireSync holds no user secret of its own by default.

```
Mozilla, on their own sign-in page          This device
  │ (FireSync never sees the password)        │
  ▼                                           ▼
keys_jwe ──ECDH-ES──▶ kSync                 vaultKey: AES-256-GCM,
                       │                    non-extractable, in IndexedDB
                       └─ decrypts Sync records
                                              └─ seals: vault, tokens, sync state
```

**The vault key is a non-extractable `CryptoKey`.** WebCrypto generates it with
`extractable: false` and it is stored in IndexedDB as a key *object*, never as bytes. The
raw key never exists in JavaScript, never enters `chrome.storage`, and cannot be exported by
anything — including a compromised FireSync.

**What that is worth, precisely.** It defeats every attacker who can run code but cannot read
the profile directory: a hostile page, a content script, another extension, anything dumping
extension storage. It does **not** defeat an attacker with offline access to the profile
directory, who can with effort recover it. A passphrase-derived key would; this does not.

That is a deliberate trade, and the comparison that matters is with the browser itself:
Chrome's own password store is protected by an OS-keyring key, and on Linux it falls back to
a fixed, publicly known key when no keyring is available. FireSync's default is therefore not
weaker than the browser it runs inside — but it is weaker than a passphrase, and this
document is not going to pretend otherwise.

**Two ways to get the stronger property**, neither of them mandatory:

- **Settings → Security → Add a passphrase.** PBKDF2-HMAC-SHA256 at 600 000 iterations,
  OWASP's 2023 floor, with a per-vault random salt. The key then exists only while unlocked,
  and auto-lock becomes meaningful. There is no recovery, which is why it is not the default.
- **The optional bridge**, which can hold the key in the OS keychain — libsecret, macOS
  Keychain, Windows DPAPI. Real at-rest protection with nothing to remember. Wiring it into
  the vault is the next piece of work.

An earlier version required a passphrase at setup. It was removed because it was the wrong
default for a tool whose entire premise is that you already have a password manager: it asked
users to invent and retype a secret in order to use the thing that exists so they do not have
to, and an unrecoverable one at that.

## What is stored, and where

| Location | Contents | Encrypted | Survives restart |
|---|---|---|---|
| **IndexedDB** → `firesync-keys` | The vault key, as a non-extractable `CryptoKey` object | n/a — never exists as bytes | yes |
| `chrome.storage.local` → `firesync.meta` | Protection mode, KDF parameters and salt if any | no (no secrets) | yes |
| `chrome.storage.local` → `firesync.verifier` | Passphrase check blob | AES-256-GCM | yes |
| `chrome.storage.local` → `firesync.vault` | Every credential and address | AES-256-GCM | yes |
| `chrome.storage.local` → `firesync.tokens` | Refresh token, `kSync`, `kid`, uid, email | AES-256-GCM | yes |
| `chrome.storage.local` → `firesync.sync` | High-water marks, engine sync ids | AES-256-GCM | yes |
| `chrome.storage.local` → `firesync.prefs.*` | Global and per-site settings | no (not secret) | yes |
| `chrome.storage.session` → `firesync.unlocked` | The derived key, **passphrase mode only** | n/a — memory only | **no** |

Each sealed blob names its own slot as AES-GCM additional authenticated data, so a blob
cannot be relocated from `tokens` to `vault` to confuse the reader.

`chrome.storage.session` has its access level set to `TRUSTED_CONTEXTS`, so a compromised
content script cannot read the unlocked key even if it tries.

`test/vault.test.ts` asserts directly that a saved password's plaintext never appears in
the local storage snapshot.

## What never touches disk

- The Mozilla account **password** — used to derive `authPW`, then discarded.
- The **session token** — held in service-worker memory for the duration of a sign-in and
  destroyed at Mozilla's end as soon as OAuth tokens exist. This is why the onboarding page
  holds a long-lived port open: so the worker is not killed mid-sign-in and forced to spill
  it somewhere durable.
- `kA` and `kB` — `kB` is used once to derive `kSync` and the `X-KeyID` fingerprint, then
  zeroed. Only `kSync` is persisted, which grants Sync data and nothing else.
- The **vault key** — session storage only.

## Threat model

### Defended

| Threat | Defence |
|---|---|
| A hostile page, content script or other extension tries to read the vault key | It is non-extractable and lives in this extension's IndexedDB; `exportKey` throws for everyone |
| Someone reads `chrome.storage` — by any means, including our own debugging | Only ciphertext is there; the key is not in `chrome.storage` at all |
| Someone copies the profile directory | **Partially.** Contents are AES-256-GCM, but the default device key is recoverable from that same directory with effort. A passphrase (Settings) closes this; so will OS-keychain storage via the bridge |
| A hostile page tries to read the autofill menu | Closed shadow root; the interactive part is an iframe on the extension origin |
| A hostile page tries to steal credentials via the message bus | Content scripts receive usernames and ids only; a password arrives solely in response to an explicit user pick, and the match is re-checked at reveal time in case the tab navigated |
| A phishing site claims to be `paypal.com` | eTLD+1 matching through a Public Suffix List; never substring matching. `test/uri.test.ts` covers `example.com.evil.net`, `notexample.com` and `evil.co.uk` |
| A downgrade attack serves a login page over http | An https-saved credential is never filled into an http page |
| An attacker with the vault file guesses the passphrase offline | 600 000 PBKDF2 iterations, per-vault random salt |
| A compromised sync server serves tampered records | HMAC verified before decryption, constant-time, fail closed |
| Someone walks up to an unlocked machine | Idle auto-lock via `chrome.alarms` + `chrome.idle`, and session storage clears on browser exit |
| CSRF on the OAuth redirect | Random `state`, checked before the code is used; PKCE S256 |

### Not defended

Stated plainly, because a security document that claims everything is covered is not worth
reading.

- **Malware running as the user while the vault is unlocked.** The key is in the service
  worker's memory. Nothing an extension can do fixes this; auto-lock shortens the window.
- **A malicious or compromised Chrome build.** The browser can read everything the extension
  can.
- **A hostile extension with `debugger` or broad host permissions.** Chrome does not isolate
  extensions from one another to that degree.
- **Offline analysis of a copied profile, in the default configuration.** See the key
  hierarchy above. This is the one place FireSync is weaker than it could be, and it is a
  chosen trade rather than an oversight.
- **A user who chooses a weak passphrase**, if they opt into one. Ten characters is enforced,
  which is a floor, not a guarantee.
- **Traffic analysis.** Mozilla's servers see when you sync and how many records you have,
  as they do for Firefox itself.
- **Supply chain.** The build has four dev dependencies and no runtime dependencies, which
  reduces but does not eliminate this.

## Deliberate design decisions

**Autofill-on-load is off by default.** Silently filling a password into a page the user has
not interacted with is how clickjacking harvests credentials. Users can turn it on per site.

**No password is ever sent to a content script speculatively.** The inline menu shows
usernames and origins. The password crosses the boundary only after a click, and the origin
match is re-evaluated at that moment.

**The unlock screen gives one error message.** "That passphrase did not unlock the vault"
covers both "wrong passphrase" and "no vault here" — distinguishing them tells an attacker
with disk access which half they got wrong.

**Auto-lock does nothing without a passphrase, and says so.** A lock screen that any click
reopens is theatre; FireSync does not schedule one in device mode rather than perform
security it is not doing.

**The `firesync-prefs` collection is not declared in `meta/global`.** Announcing an engine
Firefox does not recognise is the one thing that could genuinely confuse a real client.

**FireSync never writes to `creditcards`.** Writing a record Firefox cannot read back would
destroy payment data with no undo. Read-only until proven otherwise.

**No FireSync server exists.** There is no account to breach, no telemetry endpoint, and no
third party in the path. The extension talks to Mozilla and to nobody else.

## Cryptographic inventory

| Purpose | Primitive | Notes |
|---|---|---|
| Password stretching (Mozilla) | PBKDF2-HMAC-SHA256, 1000 | Fixed by the FxA protocol |
| Vault key derivation | PBKDF2-HMAC-SHA256, 600 000 | Ours; raise, never lower |
| Key expansion | HKDF-SHA256 | Hand-rolled over HMAC — every FxA salt is empty, and this removes any dependence on how an engine treats a zero-length salt |
| Sync records | AES-256-CBC + HMAC-SHA256 | Fixed by storage format 5 |
| Vault at rest | AES-256-GCM, 96-bit nonce, slot as AAD | Ours |
| Scoped-key transport | ECDH-ES P-256 + A256GCM (JWE) | Fixed by the FxA scoped-key spec |
| Request signing | Hawk v1, HMAC-SHA256 | Fixed by FxA and Sync |
| Password generation | `crypto.getRandomValues` with rejection sampling | Rejection sampling avoids modulo bias |

Every one of these is covered by tests, and the primitives are checked against published
vectors: RFC 5869 (HKDF), RFC 4231 (HMAC), RFC 7914 (PBKDF2), and the canonical Hawk
specification examples.

## The unsanctioned bit

FireSync reuses a Mozilla public OAuth `client_id`, because Mozilla offers no way to
register one. This is not a vulnerability in FireSync, but it is a dependency on something
outside the project's control and it belongs in an honest security document. See
[PROTOCOL.md](PROTOCOL.md#oauth-client-identity).
