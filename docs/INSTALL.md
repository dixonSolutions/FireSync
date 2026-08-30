# Installing FireSync

**No command line, no build tools.** Download one file, drag it in, done in about a minute.

| Your browser | Download | Then |
|---|---|---|
| Chromium, Brave, Vivaldi, ungoogled-chromium | the **`.crx`** | Drag it onto `chrome://extensions` |
| Google Chrome, Edge, anything else | the **`.zip`** | Unzip, then **Load unpacked** |

Get both from **<https://dixonsolutions.github.io/FireSync/>** or the
[latest release](https://github.com/dixonSolutions/FireSync/releases/latest).

Stock Chrome refuses off-store `.crx` files — that is a Chrome rule, not a fault in the
package — so the `.zip` route is the one that works everywhere.

Step-by-step for each below, then [first run](#first-run).

---

## Chromium, Brave, Vivaldi, ungoogled-chromium

### The comfortable way — no Developer mode, auto-updating

```bash
curl -fsSLO https://dixonsolutions.github.io/FireSync/install.sh
less install.sh          # it runs as root; read it before you run it
sudo bash install.sh
```

It detects the Chromium-family browsers you have installed and drops a managed-policy JSON
into each one's `/etc/<browser>/policies/managed/`. On restart the browser installs FireSync
itself, pins it to the toolbar, keeps it updated from this project's update manifest, and
switches off its own password manager so you do not get two save prompts.

`sudo bash install.sh --uninstall` reverses it.

There is a lighter variant that only installs the extension and changes nothing else:

```bash
sudo bash install.sh --method drop
```

That writes an [external-extensions](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)
JSON into `/usr/share/chromium/extensions/`. On Linux this installs with no prompt and no
Developer mode. It is Google's own documented mechanism for exactly this.

### The quick way — Developer mode, 30 seconds

1. Download `firesync-<version>.crx`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Drag the file onto the page and confirm.

Fine for trying it out. No auto-updates, and the Developer-mode toggle stays on.

### The power-user way — a launcher flag

```bash
chromium --load-extension=/path/to/firesync
```

**Verified**: on Chromium 150 with a virgin profile and Developer mode *off*, this loads
FireSync fully — enabled, no disable reasons, service worker running, all host permissions
granted. Useful if you already launch the browser from a script or a `.desktop` file.

### What was actually tested

Honesty about provenance, since these claims matter:

| Route | Status |
|---|---|
| **Managed-policy install** (what `install.sh` does) | **Verified end to end** on Chromium 150, Debian, *unmanaged* machine. Policy written, browser started, extension fetched from the published `update.xml`, installed in ~6 seconds. `from_webstore: false`, `disable_reasons: []`, service worker running, Developer mode off throughout. |
| `--load-extension` with Developer mode off | **Verified** on Chromium 150, virgin profile |
| `/usr/share/chromium/extensions` drop-in | Directory confirmed compiled into the Chromium binary; behaviour per Google's documentation ("Linux users won't be prompted") — not run here |
| Drag-and-drop CRX | Requires Developer mode to be on |

The first row is the one that matters: **an ordinary, unmanaged Chromium installs a
self-hosted extension from policy without Developer mode.** That is not a workaround or a
loophole — it is the documented mechanism, and Chromium does not carry Chrome's Web Store
publisher-proof requirement.

## Microsoft Edge

`edge://extensions` → **Developer mode** → **Load unpacked**, or use the policy route below.
Edge documents self-hosted extensions explicitly and is the least fussy of the
Chrome-derived browsers.

## Google Chrome

Chrome requires a Web Store-issued *publisher proof* inside every CRX and rejects anything
else off-store with `CRX_REQUIRED_PROOF_MISSING`. There is no way to generate that proof
yourself. Two routes work:

**Developer mode (any Chrome, no enrolment):**

1. Download and unzip `firesync-<version>.zip`.
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → select the folder.

Chrome will periodically offer to disable developer-mode extensions; decline. There is no
auto-update on this route, which is exactly why FireSync ships its own update checker.

**Enterprise policy (managed Chrome, auto-updates):**

Requires the device to be joined to Active Directory or Microsoft Entra ID, or the browser
enrolled in Chrome Enterprise Core — which is free and works for a single machine.

```bash
# Linux
sudo packaging/linux/install.sh
```

```powershell
# Windows, elevated
.\packaging\windows\Install-FireSyncPolicy.ps1 `
  -ExtensionId <extension-id> `
  -UpdateUrl https://dixonsolutions.github.io/FireSync/update.xml
```

macOS: install `packaging/macos/com.firesync.chrome.mobileconfig` through your MDM.

The extension id is printed in every release, and shown on `chrome://extensions`. Full
matrix and troubleshooting: [DISTRIBUTION.md](DISTRIBUTION.md).

---

## First run

1. **Sign in to your Mozilla account.** One button. You authenticate on Mozilla's own page:
   FireSync never sees your password, never holds a session token, and never derives your
   master key. Two-factor codes, confirmation emails and new-device unblock codes are all
   handled there.
2. **Turn off the browser's own password manager** at `chrome://settings/autofill`. The
   one-command install did this for you. Skip it and every login form gives you two save
   prompts and two dropdowns — the most common "FireSync is broken" report.
3. **Pin FireSync to the toolbar**, so it is one click away.

That is the whole setup. There is no passphrase to choose: the vault on disk is encrypted
with a non-extractable key the browser holds for this extension, so there is nothing to
invent, retype or lose.

If you want the stronger property that a *copied profile directory* is completely inert, turn
on a passphrase at **Settings → Security → Add a passphrase**. That is opt-in rather than the
default because it is unrecoverable, and because requiring one would mean asking you to
memorise a password in order to use the thing that exists so you do not have to. The trade is
spelled out in [SECURITY.md](SECURITY.md#key-hierarchy).

## Optional: the local bridge

Adds import of your Firefox logins straight off disk — no Mozilla account, no network — plus
OS-keychain storage for the vault key.

```bash
cd bridge
./install.sh <extension-id>     # Windows: .\install.ps1 -ExtensionId <id>
node host.mjs --self-test       # confirm it works
```

Then enable it in FireSync's settings, which is where the optional `nativeMessaging`
permission is requested. Needs Node 22.5+. See [BRIDGE.md](BRIDGE.md).

## Staying up to date

**If you installed with `install.sh` (policy), the browser really does update FireSync for
you.** That is not an assumption — it was tested: a new version was published, the browser
was restarted, and it fetched and installed the update unattended in about six seconds.
Chrome checks on startup and roughly every five hours thereafter.

**If you loaded it unpacked, nothing updates it.** Chrome has no mechanism for that, and no
extension can install a new version of itself — that hole is deliberately closed. This is
the main practical reason to prefer the one-command install.

Either way FireSync also checks for itself and tells you, because an install that silently
falls behind is worse than one that nags:

| Setting | Default | What it does |
|---|---|---|
| Check automatically | **on** | Reads the release manifest on a timer and badges the toolbar icon |
| How often | 24 hours | Clamped to 1 hour – 14 days |
| Update manifest | the project's | Point it at your own host if you self-host or run a fork |
| Never | — | FireSync makes no requests to the update host at all |

The popup shows the running version and whether the browser is managing updates
(`auto-updating` versus `manual updates`), plus a **Check for updates** button. That button
does two things: it reads FireSync's own release manifest, which always works, and it calls
`chrome.runtime.requestUpdateCheck()`, which asks the browser to do a real update check.

A note on that second one, since it is easy to over-promise: `requestUpdateCheck` does issue
a genuine request to the update URL — that was observed directly in the server log. But it is
rate-limited by the browser, and in Manifest V3 the service worker that calls it may be
asleep. So it is a useful nudge rather than a guarantee, and FireSync does not rely on it
alone.

When an update exists the toolbar icon shows **↑**. On a policy install the popup says it
will install on restart; on an unpacked install it offers a download link. "Never" is
absolute: even the **Check now** button will not override it.

## Uninstalling

`chrome://extensions` → Remove. That deletes the local vault along with it — your logins
remain on Mozilla's servers and in Firefox.

To also disconnect FireSync from your Mozilla account, either use **Settings → Disconnect**
first, or remove the device at <https://accounts.firefox.com/settings#connected-services>.

If you installed the bridge: `cd bridge && ./install.sh --uninstall`.

## Building it yourself

```bash
git clone https://github.com/dixonSolutions/FireSync && cd FireSync
npm install
npm run assets
npm run build      # → dist/, load this unpacked
npm test           # 355 tests, no network needed
```

`npm run release` additionally signs a CRX. The signing key is generated on first use into
`keys/firesync.pem` and is the extension's identity — back it up, and note that a build
signed with your own key has a different extension id from the published one.
