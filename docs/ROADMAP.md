# Roadmap

## Done

- The Firefox Accounts key hierarchy, verified against published vectors
- Sign-in including TOTP, emailed confirmation codes, and sign-in unblock
- Hosted sign-in with scoped keys — the default, so the password is never handled
- Token server, Hawk signing, clock-skew correction
- Sync 1.5 storage: pagination, batching, preconditions, backoff
- Record crypto and the collection key ring
- `meta/global` handling, including engine resets
- Two-way reconciliation with last-writer-wins
- `passwords` and `addresses` engines
- The local vault: at-rest encryption, lock/unlock, auto-lock, passphrase change
- eTLD+1 matching with a bundled Public Suffix List
- Field detection, filling, capture, save/update prompts
- Per-site preferences, and the private `firesync-prefs` collection
- The optional bridge: Firefox profile import, OS keychain, loopback OAuth
- Signing, self-hosted updates, policy files for Linux/Windows/macOS
- 328 tests

## Next

**Get a real OAuth client registration from Mozilla.** Still the highest-value item: it
would replace the borrowed identifiers and remove the project's largest external risk. It no
longer blocks anything functionally — hosted sign-in ships and works — but the dependency
remains.

**Prove the credit-card path, or drop it.** Read-only and off by default until someone
verifies the payload on a real account. See [TESTING.md](TESTING.md#credit-cards).

**Sync the `firesync-prefs` collection.** The record format, merge and storage all exist;
the engine does not yet run it.

**Tombstone purging.** `expiredTombstones()` is written and tested but not called. Without
it the vault grows monotonically.

**A real import/export UI.** Bridge import exists; a CSV path for people without Firefox on
the same machine does not.

**Keychain-backed unlock in the UI.** The bridge can store the vault key; nothing offers to.

**Better multi-step login handling.** Detection finds the standalone username field; the
menu does not yet remember what was picked on step one for step two.

## Considered and declined

**Bookmarks, history, tabs, forms.** Bookmarks would mean a full tree merge with Chrome's
own bookmark API and a different conflict model — a separate project. History and tabs have
no comparable Chrome surface worth the complexity.

**A FireSync sync server.** The entire value of the design is that there isn't one. Adding
one would create an account to breach and a company to trust.

**Writing to Chrome's own password store.** `Login Data` is OSCrypt-encrypted and, since
Chrome 127 on Windows, app-bound. It is fragile, undocumented, and looks exactly like
credential theft to any endpoint agent.

**Bundling a full JOSE or ASN.1 library.** FireSync needs one JWE algorithm pair and two
DER structures. Both hand-written implementations are under 150 lines and fully tested; a
general library would be a much larger attack surface in a bundle that handles passwords.

**Firefox for Android / iOS parity.** Different sync engines, different storage, no
extension surface.

## Known limitations

- The vault key lives in memory while unlocked. Nothing an extension can do changes that;
  auto-lock shortens the window.
- Chrome's native password manager cannot be disabled from the extension. The policy files
  do it; a developer-mode install needs the user to do it by hand.
- Closed shadow roots are unreachable, so login forms inside one are invisible. This is by
  design in the platform and affects every password manager equally.
- Sites that rewrite the DOM aggressively can move an anchored overlay faster than the
  observers fire. There is a 500 ms backstop.
