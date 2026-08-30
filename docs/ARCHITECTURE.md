# Architecture

FireSync is five layers. Each one is usable and testable without the one above it, which is
why the protocol work could be finished and verified before a single pixel of UI existed.

```
  5. UI            popup · unlock · onboarding · options · overlays
  4. Autofill      detection · overlay hosting · fill · capture · per-site prefs
  3. Vault         at-rest encryption · lock state · CRUD · sync bookkeeping
  2. Sync 1.5      token server · Hawk · BSO crypto · reconcile · engines
  1. Mozilla auth  onepw derivation · auth-server client · OAuth · scoped keys
```

Nothing in layers 1–3 imports anything from `chrome.*` except through
`src/common/storage.ts`, which is why the entire protocol stack runs under Node in the test
suite.

## Module map

| Path | Responsibility |
|---|---|
| `src/common/bytes.ts` | hex / base64 / base64url, XOR, constant-time compare, record ids |
| `src/common/crypto.ts` | WebCrypto wrappers: HKDF (hand-rolled), PBKDF2, HMAC, AES-CBC, AES-GCM, ECDH |
| `src/common/hawk.ts` | Hawk v1 request signing, shared by FxA and Sync storage |
| `src/common/storage.ts` | `chrome.storage` abstraction with an in-memory double |
| `src/common/messages.ts` | The typed message protocol and its response map |
| `src/fxa/onepw.ts` | The Firefox Accounts key hierarchy |
| `src/fxa/client.ts` | Auth-server endpoints |
| `src/fxa/connect.ts` | The sign-in state machine (2FA, email codes, unblock codes) |
| `src/fxa/oauth.ts`, `jwe.ts` | The scoped-key OAuth flow and its JWE |
| `src/sync15/tokenserver.ts` | Trading an access token for Hawk credentials and a node URL |
| `src/sync15/storage.ts` | The Sync 1.5 storage API, batching, backoff, preconditions |
| `src/sync15/crypto.ts` | BSO envelope crypto and the collection key ring |
| `src/sync15/meta.ts` | `meta/global`, storage version, engine sync ids |
| `src/sync15/reconcile.ts` | Pure two-way merge |
| `src/sync15/engine.ts` | The orchestrator that runs a sync |
| `src/sync15/engines/*` | Per-collection record shapes and validation |
| `src/vault/crypto.ts`, `store.ts` | At-rest encryption and the credential store |
| `src/match/psl.ts`, `uri.ts` | Registrable-domain computation and match strategies |
| `src/prefs/*` | Global and per-site preferences |
| `src/autofill/*` | Detector, filler, overlay hosting, content script |
| `src/background/*` | Service-worker entry point, message router, alarms |
| `src/ui/*` | Extension pages and overlay iframes |

## Layer 1 — Mozilla account

Two ways in. FireSync implements both; which one is usable depends on Mozilla, not on us.

**Flow A, `fxa-credentials`** (what ships today). The user's password is stretched locally
into `authPW`; the raw password never leaves the extension and is never stored. The
resulting session token is used for exactly three calls — fetch the account keys, read the
scoped-key rotation timestamp, mint OAuth tokens — and is then destroyed, because a session
token is full account control while an `oldsync` refresh token is not.

**Flow B, scoped-key OAuth** (preferred, blocked on client registration). The user
authenticates on `accounts.firefox.com` itself and FireSync never sees the password or the
master key `kB` — Mozilla returns the 64-byte `oldsync` key already encrypted to an
ephemeral P-256 key that only this extension holds. `src/fxa/oauth.ts` and `src/fxa/jwe.ts`
are complete and tested; what is missing is a `client_id` whose redirect URI we control.

Either way the layer's output is the same four values, which are all the rest of the system
needs: `refreshToken`, `kSync`, `kid`, `uid`.

## Layer 2 — Sync 1.5

A sync run is:

1. Refresh the OAuth access token if the cached one is within 60 seconds of expiry.
2. `GET token.services.mozilla.com/1.0/sync/1.5` with that token and the `X-KeyID` header
   to obtain Hawk credentials and the user's storage node. Cached until it expires.
3. `GET /info/collections` — one request that says which collections changed at all.
4. `GET /storage/meta/global`; refuse anything but `storageVersion: 5`; compare each
   engine's `syncID` with the cached one and discard the high-water mark if it changed.
5. `GET /storage/crypto/keys`, decrypted with the `oldsync` bundle, into a key ring.
6. Per engine: fetch records newer than the high-water mark, decrypt and validate each one,
   reconcile against the local set, apply what the server won, upload what the local side
   won as a batch, then move the high-water mark.

Two decisions in there are load-bearing:

- **The `X-If-Unmodified-Since` precondition is the timestamp we just read at, not the one
  from the previous run.** Using the older value 412s on every sync that both pulls and
  pushes. There is a regression test for exactly this.
- **A record that fails HMAC verification is skipped and counted, never fatal.** One corrupt
  BSO must not stop a user's other 400 logins from syncing.

## Layer 3 — Vault

`chrome.storage.local` is a plaintext file on disk. Everything FireSync persists there is
sealed with AES-256-GCM under a key derived from a passphrase with PBKDF2-SHA256 at 600 000
iterations. The unlocked key lives only in `chrome.storage.session`, which is memory-only
and cleared when the browser exits.

Each sealed blob carries its storage slot name as additional authenticated data, so a blob
cannot be moved from the `tokens` slot to the `vault` slot to confuse the reader.

The vault passphrase is deliberately independent of the Mozilla password: deriving it from
the account password would mean a password change at Mozilla silently orphans the local
vault, and it would make one compromise into two.

## Layer 4 — Autofill

The full design is in [AUTOFILL.md](AUTOFILL.md). The structural point is the trust
boundary:

```
  page (hostile)     content script (semi-trusted)     iframe (extension origin)
  ──────────────     ─────────────────────────────     ────────────────────────
  sees only a        knows field positions and          holds the credential list
  filled .value      the ids of matching logins         for as long as it is open
                     never a password until the
                     user picks one
```

Overlays live in **closed** shadow roots so page scripts cannot reach into them; the
interactive parts are iframes on the extension origin so the page cannot read their DOM;
and the iframe talks back only through `postMessage` with a per-instance nonce.

## Service-worker lifecycle

An MV3 service worker is killed after roughly 30 seconds of inactivity. Three consequences
shaped the code:

1. **All listeners are registered synchronously at the top level of
   `src/background/index.ts`.** A listener added after an `await` misses the very event that
   woke the worker.
2. **Nothing is cached in module scope that cannot be rebuilt.** `src/background/state.ts`
   is lazily-constructed singletons; every durable value is in `chrome.storage`.
3. **An in-flight sign-in is the one exception**, because it holds a session token that must
   never touch disk. The onboarding page opens a long-lived `chrome.runtime` port, which
   keeps the worker alive for the duration of the 2FA prompt.

## Data flow: saving a password

```
user submits a login form
  └─ content script captures {username, password, fields} into a per-tab buffer
     └─ navigation commits, or the password field disappears (XHR login)
        └─ 'autofill/captured' → router
           ├─ per-site "never save"?           → no prompt
           ├─ same username, same password?    → no prompt
           ├─ same username, different password → prompt as an UPDATE
           └─ otherwise                         → prompt as a SAVE
        └─ user clicks Save
           └─ 'autofill/save' → vault.addPassword() → dirty
              └─ debounced sync (3 s) → batched upload → Firefox has it
```
