# Notice on independence, trademarks, and good faith

FireSync is a personal hobby project. This page says plainly what it is, what it is not, and
what will happen if anyone named here objects to it.

## Not affiliated, not endorsed, not a competitor

FireSync is **not** produced, sponsored, endorsed, reviewed, or condoned by Mozilla
Foundation, Mozilla Corporation, Google LLC, or any of their subsidiaries or affiliates. No
relationship of any kind exists between this project and those organisations.

It is **not a competing product**. It does not replace Firefox, it does not draw users away
from Firefox, and it has no commercial interest of any kind — there is nothing to buy, no
subscription, no advertising, no telemetry, and no revenue. Its entire purpose is to let a
person who already uses Firefox Sync reach **their own data, with their own credentials,
from a second browser they also use**. Most people who install it will keep using Firefox;
that is the point.

Nor does it intervene in Mozilla's operation of its services. It behaves as a well-mannered
client: it honours `X-Weave-Backoff` and `Retry-After` unconditionally, syncs on a
conservative interval, batches its writes, refuses to poll when locked, and does nothing at
all until a user signs in with their own account.

## No Mozilla code is included

Every line in this repository was written for this project. Nothing is copied, derived,
decompiled, or translated from Firefox, from `mozilla-central`, from `application-services`,
or from any other Mozilla codebase.

The protocol implementation was written from **public documentation**: the Firefox Accounts
onepw and scoped-key specifications, the Sync 1.5 storage API documentation, the storage
format 5 specification, the token server README, and published IETF RFCs (5869, 4231, 7914,
7516, 7518, 8252) together with the public Hawk specification. These are documents Mozilla
publishes so that clients can be written. That is what was done with them.

## Trademarks

"Mozilla", "Firefox", "Firefox Sync", "Google", "Chrome" and "Chromium" are trademarks of
their respective owners. FireSync claims no rights in them and uses them only
**nominatively** — to describe accurately what the software interoperates with, which is
the only way to describe it at all.

The name "FireSync", the icon, and the banner are original to this project. No Mozilla or
Google logo, wordmark, icon, colour scheme, or brand asset is reproduced anywhere in this
repository or in the built extension. Nothing here is designed to be mistaken for an
official product, and every distribution surface says so.

## On the OAuth client identifier

Stated openly rather than buried, because it is the one thing Mozilla might reasonably
object to.

Firefox Accounts offers no self-serve OAuth client registration. To obtain an access token
with the `oldsync` scope, a client must present a registered `client_id`. FireSync therefore
reuses a Mozilla **public** client identifier — public by construction, since it ships inside
every Firefox binary — as every third-party Sync client does.

FireSync treats this as a configuration value, not a constant, precisely so it can be
changed. **If Mozilla would prefer this project use its own registered client, we would very
much like that and will use it immediately.** If Mozilla would prefer the borrowed
identifier not be used at all, tell us and it will be removed, even though doing so disables
sign-in. The project ships a local Firefox-profile import path that depends on none of this.

## Nothing here circumvents anything

FireSync does not break, weaken, or work around any protection measure. Users authenticate
with their own credentials, to their own accounts, and receive their own data — the same data
Firefox itself would fetch, encrypted with the same key, which FireSync derives locally and
never transmits. There is no FireSync server; no data ever reaches this project or its
author. The extension holds strictly less than the browser it runs in.

## A request, made plainly

To Mozilla, to Google, and to anyone else with a concern:

**Please contact us before filing a takedown.** Open an issue, open a private security
advisory, or email the maintainers. We will reply quickly, engage in good faith, and comply
with a reasonable request — including renaming, removing functionality, changing the
identifier, adding disclaimers, or taking the project down entirely.

This is a hobby project written for interoperability, maintained by one person, with no
commercial interest and no wish to be a nuisance to anyone. A conversation will get a better
outcome than a DMCA notice, and it will get it faster.

To be clear about what this page is: it is a statement of intent and good faith. It is not
legal advice, it does not purport to be a legal defence, and it creates no obligation on
anyone. It is here so that our position and our willingness to cooperate are on the record
and easy to find.

## Contact

- Issues: <https://github.com/dixonSolutions/FireSync/issues>
- Security and takedown requests: a private security advisory on the repository, or the
  maintainer address on the GitHub profile.
