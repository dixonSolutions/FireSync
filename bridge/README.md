# FireSync bridge

An **optional** native messaging host. FireSync works without it; installing it adds three
things an extension sandbox cannot do on its own.

| Capability | What it gives you |
|---|---|
| `profile` | Import your Firefox logins straight from `logins.json` + `key4.db` — no Mozilla account, no network, no OAuth |
| `keychain` | Keep the vault key in the OS keychain so you are not asked for a passphrase every restart |
| `oauth` | RFC 8252 loopback sign-in (dormant until FireSync has its own registered OAuth client) |

## Install

```bash
./install.sh <extension-id>          # id is on chrome://extensions
./install.sh --uninstall
```

Windows:

```powershell
.\install.ps1 -ExtensionId <extension-id>
.\install.ps1 -Uninstall
```

Then enable the bridge in FireSync's settings, which is where the `nativeMessaging`
permission is requested — it is optional and not granted at install time.

## Check it works

```bash
node host.mjs --self-test
```

Prints the host's capabilities and the Firefox profiles it can see. If that works and the
extension still cannot reach it, the manifest's `allowed_origins` has the wrong extension
id.

## Requirements

Node 22.5 or newer, for `node:sqlite`. No npm dependencies.

## What it does not do

- It does not listen on a socket. Chrome starts it, talks over stdin/stdout, and kills it.
- It does not run in the background. No daemon, no autostart.
- It does not make network requests, except the loopback listener during a sign-in you
  started, which is bound to `127.0.0.1` and accepts exactly one request.
- It never writes to your Firefox profile. Everything is read-only.

Full rationale and threat model: [../docs/BRIDGE.md](../docs/BRIDGE.md).
