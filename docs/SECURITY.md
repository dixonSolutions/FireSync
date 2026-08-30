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

Two independent secrets, deliberately not derived from each other:

```
Mozilla account password              FireSync vault passphrase
  │ PBKDF2(1000) + HKDF                 │ PBKDF2-SHA256(600 000)
  ▼                                     ▼
authPW ──▶ Mozilla                    vaultKey (AES-256-GCM)
unwrapBKey ──▶ kB ──▶ kSync             │
                       │                └─ seals: vault, tokens, sync state
                       └─ decrypts Sync records
```

Deriving the vault key from the Mozilla password would mean a password change at Mozilla
silently orphans the local vault, and would turn one compromise into two. The 1000-iteration
count on the Mozilla side is fixed by their protocol and is not a number FireSync gets to
choose; the 600 000 on the vault side is ours, and follows OWASP's 2023 floor for
PBKDF2-HMAC-SHA256.

## What is stored, and where

| Location | Contents | Encrypted | Survives restart |
|---|---|---|---|
| `chrome.storage.local` → `firesync.meta` | KDF parameters, salt, version | no (no secrets) | yes |
| `chrome.storage.local` → `firesync.verifier` | Passphrase check blob | AES-256-GCM | yes |
| `chrome.storage.local` → `firesync.vault` | Every credential and address | AES-256-GCM | yes |
| `chrome.storage.local` → `firesync.tokens` | Refresh token, `kSync`, `kid`, uid, email | AES-256-GCM | yes |
| `chrome.storage.local` → `firesync.sync` | High-water marks, engine sync ids | AES-256-GCM | yes |
| `chrome.storage.local` → `firesync.prefs.*` | Global and per-site settings | no (not secret) | yes |
| `chrome.storage.session` → `firesync.unlocked` | The derived vault key | n/a — memory only | **no** |

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
| Someone reads the extension's files off a powered-down disk | Everything sensitive is AES-256-GCM under a 600 000-iteration KDF |
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
- **A user who chooses a weak vault passphrase.** The setup page enforces 10 characters,
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
