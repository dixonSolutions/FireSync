# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-08-30

First release. Alpha: the protocol layers are complete and covered end to end against an
in-memory Sync server, but have not been exercised against a large real account.

### Added

**Mozilla account**
- The full onepw key hierarchy, verified against published RFC vectors
- Sign-in with TOTP, emailed confirmation codes, and new-device unblock codes
- OAuth token minting and refresh; the session token is destroyed as soon as it is spent
- Scoped-key OAuth with `keys_jwk` and ECDH-ES JWE decryption — complete, pending a client
  registration
- Optional FxA device registration so the connection is revocable from Mozilla's settings

**Sync**
- Token server exchange with `X-KeyID`, Hawk signing, clock-skew correction
- Sync 1.5 storage: pagination, atomic batched writes, `X-If-Unmodified-Since`, backoff
- Storage-format-5 record crypto and the collection key ring
- `meta/global` handling, including detecting an engine reset in Firefox
- Two-way reconciliation, last-writer-wins on `timePasswordChanged`
- `passwords` and `addresses` engines; `creditcards` read-only and off by default
- A private `firesync-prefs` collection for FireSync's own per-site settings

**Vault**
- AES-256-GCM at rest under a PBKDF2-SHA256 key at 600 000 iterations
- Slot-bound AAD so a sealed blob cannot be relocated
- Idle auto-lock, lock on browser exit, passphrase change with full re-encryption

**Autofill**
- Field and form detection with `autocomplete` tokens, structural position and token
  scoring, including compound-noun languages and open shadow roots
- Closed-shadow-root overlays hosting extension-origin iframes
- Framework-safe filling via the native value setter
- Save and update prompts, including for XHR logins that never navigate
- eTLD+1 matching with a bundled Public Suffix List and curated equivalent domains
- Per-site preferences: never-save, match strategy, inline menu mode, autofill-on-load

**Bridge (optional)**
- Native messaging host with local Firefox profile import — no account, no network
- Both modern (PBKDF2/AES) and legacy (SHA-1/3DES) `key4.db` wrapping
- OS keychain access on Linux, macOS and Windows
- RFC 8252 loopback OAuth, dormant pending a client registration
- Per-user installers for every Chromium-family browser

**Distribution**
- CRX3 signing, extension-id derivation, self-hosted `update.xml`
- Policy files for Linux, Windows and macOS that also disable Chrome's own password manager

**Project**
- 328 tests: RFC and specification vectors, independently written encoders, a fake Sync
  server, and a synthetic Firefox profile
- Ten documents covering architecture, protocol, security, autofill, the bridge,
  distribution, development, testing, roadmap and FAQ

### Known issues

- The OAuth client id is borrowed from Mozilla; there is no self-serve registration
- Stock unmanaged Google Chrome cannot install a self-hosted CRX; Chromium is the primary
  target
- `creditcards` is read-only until a real account has been observed round-tripping
- Tombstone purging is implemented but not yet scheduled
