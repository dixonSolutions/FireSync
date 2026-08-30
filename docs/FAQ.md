# FAQ

**Does this send my passwords anywhere?**
To Mozilla's Sync servers, encrypted with your own Sync key, exactly as Firefox does. There
is no FireSync server. Mozilla cannot read the contents, and neither can we — there is no
"we" in the data path.

**Is this Mozilla software?**
No. It is an independent project using a documented, open protocol. Not affiliated with or
endorsed by Mozilla or Google.

**Why not just export a CSV from Firefox?**
That is a one-time copy that goes stale the moment you save a password anywhere. FireSync
keeps both browsers in step in both directions. If you do want a one-time copy, the
[bridge](BRIDGE.md) does it locally with no account involved.

**Does it need my Mozilla password?**
No. The default sign-in opens `accounts.firefox.com` in a tab and you authenticate there —
FireSync never sees the password, never holds a session token, and never derives your master
key. Mozilla hands back a refresh token scoped to Sync data and your Sync key, already
encrypted to a key only this extension holds.

There is a password fallback behind a disclosure in setup, for when that flow is
unavailable. It derives an authentication value locally and discards the password
immediately, but FireSync does briefly handle it — which is exactly what the default avoids.

**Does it ask for anything else?**
No. Setup is one button. The vault on disk is encrypted with a non-extractable key the
browser holds for this extension — nothing to invent, nothing to retype, nothing to lose.

If you want the stronger property that a stolen profile directory is completely inert, turn
on a passphrase in Settings → Security. That is opt-in because it is unrecoverable, and
because requiring one by default would mean asking you to memorise a password in order to use
the thing that exists so you do not have to.

**Why a separate FireSync passphrase?**
Because the alternative is worse. If the vault key came from your Mozilla password, changing
that password would orphan the local vault, and one compromise would become two.

**I forgot the FireSync passphrase.**
If you opted into one, there is no recovery — that is what it buys. Reset the vault and sign
in again; your logins are on Mozilla's servers, not only on this machine.

**Why can't I install it on my normal Chrome?**
Chrome requires a Web Store-issued publisher proof inside every CRX and refuses anything
else off-store. The exemptions are enterprise policy on a managed browser, and developer
mode. Chromium has no such requirement, which is why it is the primary target. Full detail
in [DISTRIBUTION.md](DISTRIBUTION.md).

**Why am I getting two save-password prompts?**
Chrome's own manager is still on. Turn it off at `chrome://settings/autofill`, or deploy the
policy files in `packaging/`, which do it for you.

**Why build a password UI at all — why not embed or redirect to Mozilla's?**
Because there isn't one to embed. Firefox's password manager is `about:logins`, a
browser-internal page that only Firefox can render; Chrome cannot load it. The standalone
Mozilla password app, Lockwise, reached end of life in December 2021 and its features were
folded back into Firefox itself. `accounts.firefox.com` manages the *account* — password,
two-factor, devices — not the passwords in it.

Even if a hosted page existed, it could not decrypt anything. Your Sync key never leaves the
extension, and handing it to a page in an iframe would defeat the entire point of holding it
locally.

What FireSync *does* delegate is everything about the account: signing in, two-factor,
recovery keys, and revoking access all happen on Mozilla's pages, and Settings links straight
to them. Reimplementing those would mean handling credentials FireSync goes out of its way
never to touch.

**Why doesn't FireSync appear in Chrome's autofill dropdown?**
It cannot. `chrome.passwordsPrivate` and `chrome.autofillPrivate` are restricted to
extensions shipped inside the browser. Every third-party password manager draws its own UI
for the same reason.

**Why are credit cards read-only?**
Firefox also protects card numbers with an OS keystore and the payload schema has changed
more than once. Writing a record Firefox cannot read back would destroy payment data with no
undo, so FireSync will not write there until someone has verified a round-trip on a real
account.

**Do I need the bridge?**
No. It is optional and nothing in the core path uses it. It adds local Firefox import, OS
keychain storage, and a future sign-in route. See [BRIDGE.md](BRIDGE.md).

**Is the borrowed OAuth client id a problem?**
It is the project's largest external risk, and it is stated as such in the README, the
protocol reference and the security document. Mozilla offers no way to register a client, so
every third-party Sync client does this. It works today; it could stop. The bridge's local
import path exists partly as insurance.

**Does it work with a Mozilla account that has 2FA?**
Yes — TOTP, emailed confirmation codes, and the new-device unblock flow are all handled.

**What about Firefox's primary password?**
Irrelevant to sync (Sync uses your account password), but the bridge's local import will ask
for it, because that is what protects `key4.db` on disk.

**Can I use it on more than one machine?**
Yes. Each machine has its own vault passphrase and its own local vault; they converge
through Mozilla's servers like any two Firefox installs.

**Will you publish it to the Chrome Web Store?**
Not currently the plan — that is the constraint the whole distribution design is built
around. An *unlisted* listing remains the pragmatic fallback for people who need stock
Chrome; see [DISTRIBUTION.md](DISTRIBUTION.md#recommended-paths-in-order).
