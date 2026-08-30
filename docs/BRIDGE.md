# The local bridge

FireSync ships an **optional** native messaging host. This document is why it exists, what
it can and cannot do, and why it is optional rather than required.

## The question it answers

FireSync's largest external dependency is not technical. Firefox Accounts has no self-serve
OAuth client registration, so any third-party Sync client has to reuse a Mozilla public
`client_id`. It works, everyone does it, and Mozilla could switch it off tomorrow.

A local IPC bridge does **not** fix that — whatever process performs the OAuth still needs a
registered client. What it does instead is provide a **second, completely independent path**
that never touches Mozilla at all: read the user's own Firefox profile off their own disk
and decrypt it locally. If the borrowed client id stops working, FireSync still imports and
still autofills; it just stops syncing back.

That is the case for building it. The other two capabilities are conveniences.

## What it does

| Capability | Value | Depends on |
|---|---|---|
| `profile.list` / `profile.import` | Decrypt `logins.json` + `key4.db` locally. No account, no network, no OAuth. | Firefox installed on the same machine |
| `keychain.get/set/delete` | Keep the vault key in the OS keychain so the passphrase is not needed on every restart | libsecret / macOS Keychain / DPAPI |
| `oauth.loopback` | RFC 8252 sign-in against `http://127.0.0.1:<port>/` | **A registered OAuth client.** Dormant today |

## Why it is optional, and stays optional

A native host means an installer, a per-OS code path, and a second thing that can be out of
date. FireSync's core — sign in, sync, autofill, save — works with none of it, and no code
on that path calls into the bridge. `BridgeClient` fails soft by design: an absent host
produces `BridgeUnavailableError`, which the settings page renders as "not installed" rather
than as an error.

The `nativeMessaging` permission is in `optional_permissions`, not `permissions`. It is
requested from a click in FireSync's settings and can be revoked without reinstalling.

## Transport

Chrome's native messaging: the browser starts the process, writes 32-bit little-endian
length-prefixed JSON to its stdin, reads the same from its stdout, and kills it when the
port closes.

```
 extension                          host process
 ─────────                          ────────────
 chrome.runtime.connectNative  ──▶  spawned by Chrome
 port.postMessage({id, method}) ─▶  stdin   [len][json]
 port.onMessage                ◀──  stdout  [len][json]
 port.disconnect()             ──▶  SIGTERM
```

There is **no socket and no port**. The one exception is `oauth.loopback`, which binds a
one-shot listener to `127.0.0.1` on an OS-assigned port for the duration of a sign-in the
user started, and closes it as soon as the redirect arrives.

Each request carries an `id`; each reply is `{id, ok: true, result}` or
`{id, ok: false, error, code}`. Calls time out client-side after 30 s.

## How the Firefox import works

Firefox keeps logins in `logins.json`, each field encrypted with 3DES-CBC under a key held
in `key4.db`. That key is itself wrapped with a key derived from the profile's global salt
and the user's primary password — the empty string on most profiles.

```
key4.db  metadata(id='password').item1   →  globalSalt
key4.db  metadata(id='password').item2   →  PBES2 blob decrypting to "password-check"
key4.db  nssPrivate.a11                  →  the same wrapping, around the 24-byte 3DES key
logins.json encryptedUsername/Password   →  3DES-CBC under that key
```

Two wrapping schemes exist and both are implemented:

- **Modern** (Firefox 75+): `PBKDF2-SHA256(SHA1(globalSalt ‖ password), entrySalt, iterations)`
  then AES-256-CBC. NSS stores a 14-byte IV that must be prefixed with `0x04 0x0e` — a
  genuine quirk of the format, and the thing most reimplementations get wrong first.
- **Legacy**: a SHA-1/HMAC construction yielding a 24-byte 3DES key and an 8-byte IV.

`test/bridge.test.ts` builds a synthetic profile — a real SQLite `key4.db` and a real
`logins.json` — with an encryptor written independently of the decryptor, and round-trips
both schemes.

### Failure handling

- **A primary password** is reported as `primary-password-required`, distinct from
  `primary-password-wrong`, so the UI can prompt once and then say "that was not it".
- **One unreadable record** increments a `skipped` counter and the import continues. A
  single malformed entry must not cost the user their other several hundred logins.
- **The profile is never written to.** Every file is opened read-only.

Imported logins are matched against the vault on `(origin, username)` so importing twice
does not duplicate anything.

## Security

**Trust.** The bridge is a local process the user installed deliberately. It has the user's
own file permissions and can already read `logins.json` — installing it grants no authority
that a program running as that user did not already have.

**Origin binding.** The host manifest's `allowed_origins` lists exactly one extension id.
Another extension cannot start it, and Chrome enforces this before the process is spawned.

**Input handling.** Every request is validated before use: `oauth.loopback` refuses a
non-https authorization URL, keychain calls require an account name, and the framing decoder
refuses a frame larger than Chrome's own cap rather than allocating on a bad length.

**The DER reader is deliberately small.** It handles the two fixed structures NSS uses and
nothing else; a general ASN.1 library would be a large attack surface in a process handling
an entire password store. It validates PKCS#7 padding rather than trusting the last byte.

**No persistence, no daemon.** The host stores nothing, starts only when Chrome starts it,
and exits when the port closes.

**What it does not defend against.** Malware already running as the user. It cannot: the
threat model of "a local process reading local files" has no defence against another local
process that could read the same files directly.

## Installing

```bash
cd bridge
./install.sh <extension-id>     # id from chrome://extensions
node host.mjs --self-test       # check it works standalone
```

Windows: `.\install.ps1 -ExtensionId <id>`. Uninstall with `--uninstall` / `-Uninstall`.

Then open FireSync's settings, click **Enable** on the bridge card — that is where the
`nativeMessaging` permission is requested — and the detected Firefox profiles appear with an
Import button.

Requires Node 22.5+ for `node:sqlite`. No npm dependencies.

## What would change if Mozilla registered a client for FireSync

`oauth.loopback` becomes live and the recommended sign-in, and the bridge stops being
optional-but-useful and becomes optional-and-better:

- The password is typed on `accounts.firefox.com`, never in FireSync.
- FireSync never derives or holds `kB`; Mozilla returns `kSync` already wrapped to an
  ephemeral key.
- Every 2FA, recovery and passkey flow is Mozilla's problem, not ours.

The extension-side half of that flow is already written and tested
(`src/fxa/oauth.ts`, `src/fxa/jwe.ts`); only the registration is missing. See
[PROTOCOL.md](PROTOCOL.md#oauth-client-identity).
