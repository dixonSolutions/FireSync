# Protocol reference

Everything FireSync sends and receives, with the exact strings. If you are debugging a
sync that will not start, work down this page in order — each step depends only on the ones
above it.

Notation: `KW(x)` is `"identity.mozilla.com/picl/v1/" + x`. Every HKDF here uses an **empty
salt**, which RFC 5869 defines as 32 zero bytes for SHA-256.

---

## 1. The key hierarchy

```
password ─┐
          ├─PBKDF2-SHA256(1000)──▶ quickStretchedPW ─┬─HKDF─▶ authPW      (sent to Mozilla)
email ────┘  salt = KWE("quickStretch", email)       └─HKDF─▶ unwrapBKey  (never leaves the device)

keyFetchToken ─HKDF(96)─▶ tokenId | reqHMACkey | requestKey
requestKey    ─HKDF(96)─▶ respHMACkey | respXORkey
bundle[0:64] XOR respXORkey ─▶ kA | wrapKB
wrapKB XOR unwrapBKey ──────▶ kB          ◀── the master key
kB ─HKDF(64), info=KW("oldsync")─▶ kSync = syncEncKey | syncHmacKey
```

| Value | Derivation | Length |
|---|---|---|
| `quickStretchedPW` | `PBKDF2-HMAC-SHA256(password, KWE("quickStretch", email), 1000)` | 32 |
| `authPW` | `HKDF(quickStretchedPW, "", KW("authPW"))` | 32 |
| `unwrapBKey` | `HKDF(quickStretchedPW, "", KW("unwrapBkey"))` | 32 |
| keyFetch creds | `HKDF(keyFetchToken, "", KW("keyFetchToken"), 96)` | 32+32+32 |
| session creds | `HKDF(sessionToken, "", KW("sessionToken"), 64)` | 32+32 |
| keys response | `HKDF(requestKey, "", KW("account/keys"), 96)` | 32+64 |
| `kSync` | `HKDF(kB, "", KW("oldsync"), 64)` | 64 |
| `X-KeyID` | `` `${keyRotationTimestamp}-${base64url(SHA256(kB)[0:16])}` `` | — |

Note the fingerprint in `X-KeyID` is over **`kB`**, not `kSync`, and is **base64url**. The
legacy `X-Client-State` header used the same 16 bytes in **hex**.

Implemented in `src/fxa/onepw.ts`; verified against RFC 5869 / RFC 4231 / RFC 7914 vectors
in `test/crypto.test.ts` and `test/onepw.test.ts`.

---

## 2. Auth server — `https://api.accounts.firefox.com/v1`

### `POST /account/login?keys=true`

```json
{ "email": "ada@example.org", "authPW": "<hex>", "reason": "login" }
```

Returns `{uid, sessionToken, keyFetchToken, verified, verificationMethod}`. The password
itself is never sent.

Failure modes worth branching on:

| errno | Meaning | FireSync's response |
|---|---|---|
| 102 / 103 | Unknown account / wrong password | Generic "sign-in failed" |
| 125 | Request blocked (new device or IP) | `POST /account/login/send_unblock_code`, then ask for the code |
| 138 | Session unverified | Ask for the emailed code |
| 114 | Rate limited | Honour `retryAfter` |
| 111 | Invalid timestamp | Adopt the server clock from the `Timestamp` header and retry once |

### Verification

- `POST /session/verify/totp` — `{code, service: "sync"}`, Hawk-authenticated with the
  session token.
- `POST /session/verify_code` — `{code}` from the sign-in email.
- `POST /session/resend_code` — send it again.

**The keyFetchToken must not be spent before the session is verified**, and it is
single-use. `ConnectSession` in `src/fxa/connect.ts` enforces that ordering.

### `GET /account/keys`

Hawk-authenticated with `id = hex(tokenId)`, `key = reqHMACkey` from the keyFetchToken.
Returns `{bundle: "<hex, 96 bytes>"}`:

```
ciphertext = bundle[0:64]
mac        = bundle[64:96]
assert HMAC-SHA256(respHMACkey, ciphertext) == mac      ← fail closed
kA | wrapKB = ciphertext XOR respXORkey
kB = wrapKB XOR unwrapBKey
```

### `POST /account/scoped-key-data`

Hawk-authenticated with the session token. `{client_id, scope}` returns
`{"<scope>": {identifier, keyRotationSecret, keyRotationTimestamp}}`. Only
`keyRotationTimestamp` is used, as the left half of `X-KeyID`.

### `POST /oauth/token`

Three grant types are used:

```jsonc
// Hawk-authenticated with the session token
{ "grant_type": "fxa-credentials", "client_id": "...", "scope": "<oldsync>", "access_type": "offline" }

// unauthenticated
{ "grant_type": "refresh_token",   "client_id": "...", "refresh_token": "...", "scope": "<oldsync>" }

// unauthenticated, the scoped-key flow
{ "grant_type": "authorization_code", "client_id": "...", "code": "...", "code_verifier": "..." }
```

Scope is always `https://identity.mozilla.com/apps/oldsync`.

### `POST /session/destroy`

Called immediately once OAuth tokens are in hand. This matters: a session token is full
account control, an `oldsync` refresh token is read/write access to Sync data and nothing
else.

### `POST /account/device`

Optional. Registers "FireSync on Linux" in the user's device list so the connection is
visible and revocable from Mozilla's own settings page. Best effort — a failure costs a
list entry, not a sync.

---

## 3. Token server — `https://token.services.mozilla.com/1.0/sync/1.5`

```http
GET /1.0/sync/1.5
Authorization: Bearer <oldsync access token>
X-KeyID: 1510628805-Voc-Eb9IpoTINuo9ll7bjA
```

```json
{ "id": "...", "key": "...", "uid": 12345,
  "api_endpoint": "https://sync-1-us-west1-g.sync.services.mozilla.com/1.5/12345",
  "duration": 3600, "hashalg": "sha256" }
```

- `401` — the access token is expired or revoked, or `X-KeyID` is wrong for this account.
  Refresh once, then force a full re-auth.
- `404` — the account has never had Sync provisioned.

`id` and `key` are Hawk credentials for the storage node, cached until 5 minutes before
`duration` elapses.

BrowserID assertions, which older third-party clients used here, are gone. OAuth is the
only route.

---

## 4. Sync 1.5 storage

Every request is Hawk-signed with the token-server credentials, including a payload hash on
`PUT`/`POST`.

| Request | Purpose |
|---|---|
| `GET /info/collections` | Collection name → last-modified. The cheap "did anything change?" call |
| `GET /info/configuration` | `max_post_records`, `max_post_bytes` — batch limits this node enforces |
| `GET /storage/<c>?full=1&newer=<ts>&limit=200` | Records changed since the high-water mark |
| `GET /storage/<c>/<id>` | One BSO |
| `PUT /storage/<c>/<id>` | Write one BSO |
| `POST /storage/<c>?batch=true` … `&commit=true` | Atomic batched write |
| `DELETE /storage/<c>?ids=a,b` | Hard delete — prefer a tombstone for synced collections |

Headers that carry the protocol's manners, all handled in `src/sync15/storage.ts`:

- `X-Weave-Timestamp` — the server's clock; adopted as a Hawk offset. Clock skew is the
  single most common cause of unexplained 401s.
- `X-Last-Modified` — the collection's timestamp, and the next run's high-water mark.
- `X-Weave-Next-Offset` — pagination.
- `X-If-Unmodified-Since` (request) → `412` — the optimistic-concurrency precondition. On
  412, discard the high-water mark and re-reconcile; never force.
- `X-Weave-Backoff` / `Retry-After` — honoured unconditionally. Getting throttled off
  Mozilla's infrastructure is the fastest way to kill a project like this.

### Record format (storage version 5)

A BSO's `payload` is a JSON **string**:

```json
{ "ciphertext": "<base64>", "IV": "<base64, 16 bytes>", "hmac": "<hex>" }
```

```
hmac = HMAC-SHA256(hmacKey, ASCII(ciphertext_base64_string))     ← over the base64 TEXT
plaintext = AES-256-CBC-decrypt(encKey, IV, base64decode(ciphertext))
```

That the HMAC covers the base64 text rather than the raw bytes is the classic
implementation trap. `test/sync-crypto.test.ts` asserts both that the right interpretation
verifies and that the wrong one does not.

`crypto/keys` is itself such a record, encrypted with the `oldsync` bundle:

```json
{ "id": "keys", "collection": "crypto",
  "default": ["<encKey b64>", "<hmacKey b64>"],
  "collections": { "passwords": ["...", "..."] } }
```

Every other collection uses its override if present, else `default`.

### `meta/global` — unencrypted

```json
{ "storageVersion": 5, "syncID": "...",
  "engines": { "passwords": {"version": 1, "syncID": "..."} },
  "declined": ["creditcards"] }
```

FireSync refuses any `storageVersion` other than 5, and treats a changed engine `syncID` as
"this engine was reset in Firefox — discard every incremental marker for it".

### Collections

**`passwords`**

```json
{ "id": "<12-byte base64url>", "hostname": "https://example.com",
  "formSubmitURL": "https://example.com", "httpRealm": null,
  "username": "ada", "password": "hunter2",
  "usernameField": "email", "passwordField": "pass",
  "timeCreated": 1735689600000, "timePasswordChanged": 1735689600000,
  "timeLastUsed": 1735689600000, "timesUsed": 3 }
```

**Exactly one** of `formSubmitURL` and `httpRealm` is non-null — form logins set the
former, HTTP-auth logins the latter. Firefox ignores records that break this.
`hostname` is a bare origin: no path, no query.

**`addresses`** — fields live inside an `entry` sub-object carrying a schema `version`.
FireSync writes version 1 and passes unknown fields through untouched, so round-tripping a
record written by a newer Firefox does not destroy data.

**`creditcards`** — read-only and off by default; see
[README](../README.md#status) for why.

**`firesync-prefs`** — FireSync's own collection. Sync 1.5 accepts arbitrary collection
names and Firefox ignores collections it has no engine for, which gives per-site settings a
free, end-to-end encrypted, cross-device home. It is deliberately **not** declared in
`meta/global`.

### Conflict resolution

Per record, last-writer-wins on `timePasswordChanged` (the same authority Firefox uses),
with a tombstone winning an exact tie so a deletion is never silently resurrected.

Logins are never merged field-by-field. Doing so would invent a username/password pair that
never existed on either device — the worst failure a password manager can have.

---

## OAuth client identity

The project's remaining external dependency, stated openly.

Firefox Accounts has **no self-serve OAuth client registration**. To obtain an access token
with the `oldsync` scope, a client must present a registered `client_id`. FireSync therefore
reuses Mozilla **public** client identifiers — public by construction, since they ship inside
released binaries — as every third-party Sync client does.

It uses two, for a reason that is not obvious:

| Flow | `client_id` | Registered redirect | Why |
|---|---|---|---|
| Hosted sign-in (default) | `3c49430b43dfba77` | `https://accounts.firefox.com/oauth/success/3c49430b43dfba77` | A plain https redirect a tab navigates to, which `chrome.tabs.onUpdated` can observe |
| Password fallback | `5882386c6d801776` | `urn:ietf:wg:oauth:2.0:oob:oauth-redirect-webchannel` | Firefox Desktop's client. Its redirect is a WebChannel an extension cannot intercept, so it is usable only for the `fxa-credentials` grant |

That distinction is the whole reason the hosted flow was initially thought impossible. It is
not: a client whose redirect is an ordinary URL makes it work, and FxA accepts such a client
with the `oldsync` scope, PKCE, and a `keys_jwk` scoped-key request. Verified against the
live service — the authorization endpoint returns 200 and renders the sign-in page.

Query any client's registration yourself:

```bash
curl https://oauth.accounts.firefox.com/v1/client/3c49430b43dfba77
```

What this means in practice:

- It works today, and reusing a public client id is what the third-party ecosystem does.
- It is **unsanctioned**. Mozilla may gate or revoke either identifier at any time, and would
  be within their rights. Both are configuration values, not constants, so they can be
  changed without a rebuild.
- **The right fix is a client registration of FireSync's own.** If Mozilla would grant one,
  it would be used immediately and this section would shrink to a sentence. See
  [../NOTICE.md](../NOTICE.md).
- The [local bridge](BRIDGE.md) imports from a Firefox profile on disk and depends on none
  of this, which is the project's insurance against that risk.
