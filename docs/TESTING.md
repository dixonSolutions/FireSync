# Testing

```bash
npm test           # 328 tests across 17 files
npm run coverage
npx vitest run test/engine.test.ts     # one file
npx vitest                             # watch
```

No test touches the network, and none needs a Mozilla account.

## What is covered

| File | Tests | What it proves |
|---|---|---|
| `crypto.test.ts` | 25 | HKDF, HMAC, SHA-256, PBKDF2 and AES against **published RFC vectors** |
| `hawk.test.ts` | 13 | Request signing against the **canonical Hawk spec examples** |
| `onepw.test.ts` | 18 | The FxA key hierarchy, including unbundling `/account/keys` |
| `jwe.test.ts` | 18 | ECDH-ES JWE decryption, the Concat KDF, PKCE, the OAuth redirect |
| `sync-crypto.test.ts` | 19 | The BSO envelope, the base64-text HMAC, tamper detection, key rings |
| `storage-client.test.ts` | 20 | Hawk headers, pagination, batching, 412, 401, backoff |
| `fxa-client.test.ts` | 14 | Auth-server calls and the sign-in state machine, including 2FA |
| `engine.test.ts` | 19 | **End-to-end sync** against an in-memory Sync server |
| `reconcile.test.ts` | 17 | The full conflict matrix |
| `vault.test.ts` | 23 | Encryption at rest, lock/unlock, CRUD, passphrase change |
| `uri.test.ts` | 30 | eTLD+1 matching and every phishing shape it must refuse |
| `detector.dom.test.ts` | 25 | Field detection against realistic markup, in a real DOM |
| `prefs.test.ts` | 17 | Global and per-site settings, and the synced prefs record |
| `passwords.test.ts` | 19 | Record shape and the Firefox invariants |
| `addresses.test.ts` | 9 | Address and credit-card record handling |
| `meta.test.ts` | 11 | `meta/global`, storage version, engine resets |
| `bridge.test.ts` | 31 | DER, NSS decryption of a **synthetic Firefox profile**, framing, the client |

## The three things that make these worth having

**Published vectors, not self-consistency.** Every cryptographic primitive is checked
against RFC 5869, RFC 4231, RFC 7914 and the Hawk specification. A round-trip test proves
only that a bug is symmetric.

**Independently written encoders.** Where no published vector exists, the test builds the
input with a *separately written* implementation: `test/helpers/der-encode.mjs` encodes DER
that `bridge/lib/der.mjs` parses; `test/jwe.test.ts` has its own Concat KDF and JWE
encryptor; `test/onepw.test.ts` builds an `/account/keys` bundle the way the server would;
`test/sync-crypto.test.ts` builds a payload envelope by hand.

**A fake Sync server.** `test/helpers/fake-sync-server.ts` implements enough of the real
protocol — Hawk auth, `X-Last-Modified`, `X-If-Unmodified-Since` with 412s, batched POSTs,
`X-Weave-Next-Offset`, `X-Weave-Backoff` — to drive the whole `SyncEngine` end to end.
`test/helpers/firefox-profile.mjs` does the same for the bridge, writing a real SQLite
`key4.db` and `logins.json` whose plaintext the test knows.

Two real bugs were caught by these before any browser ran the code:

- `X-If-Unmodified-Since` was being sent with the *previous* sync's timestamp, which would
  have 412'd on every run that both pulled and pushed — i.e. bidirectional sync would have
  essentially never worked.
- `randomBytes` silently exceeded `getRandomValues`' 64 KiB cap for large requests.

## What is deliberately not tested

- **The UI pages.** Excluded from coverage. They are thin views over the message bus.
- **Real network calls.** By design.
- **Chrome APIs.** `chrome.alarms`, `chrome.idle` and the like are exercised by hand.
- **The keychain module.** Every branch shells out to a platform tool that only exists on
  that platform.
- **The `creditcards` collection end to end.** See below.

## Before you trust it

FireSync writes to a real password store. Test with a throwaway account first.

1. Create a fresh Mozilla account and sign a real Firefox into it.
2. Save three or four logins in that Firefox, on sites you do not care about.
3. Connect FireSync, sync, and check all of them appear.
4. Save one in Chrome, sync, and check it appears in Firefox.
5. Change the same password on both sides, sync, and confirm the newer edit wins on both.
6. Delete one on each side and confirm both deletions propagate.
7. Only then point it at an account you care about — and export your logins from Firefox
   first (`about:logins` → ⋯ → Export Logins), because that costs a minute and an untested
   sync client does not.

### Credit cards

`creditcards` is read-only and off by default. Before that changes, someone needs to confirm
on a real account that:

- the payload contains a readable `cc-number` rather than `cc-number-encrypted`;
- the `entry.version` FireSync writes is one current Firefox accepts;
- a record written by FireSync survives a Firefox restart and is still readable.

Until all three hold, writing to that collection could destroy payment data with no undo.

## Adding tests

Files live in `test/`, named `*.test.ts`. Use `*.dom.test.ts` for anything needing a DOM —
that suffix selects the happy-dom environment.

Prefer testing observable behaviour through the public surface of a module. The
`reconcile`, `uri` and `detector` suites are the model: pure functions, exhaustive cases,
no mocks.
