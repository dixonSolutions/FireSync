# Installing FireSync

Downloads: <https://dixonsolutions.github.io/FireSync/> ·
Releases: <https://github.com/dixonSolutions/FireSync/releases>

Every release publishes two files:

| File | Use it for |
|---|---|
| `firesync-<version>.zip` | Load unpacked. Works everywhere, including stock Chrome. |
| `firesync-<version>.crx` | Signed package. Drag-installable on Chromium; policy-installable on a managed Chrome. |

---

## Chromium, Brave, Vivaldi, ungoogled-chromium — the easy path

**Option A — drag the CRX in.**

1. Download `firesync-<version>.crx`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Drag the `.crx` file onto the page and confirm.

**Option B — load unpacked.**

1. Download and unzip `firesync-<version>.zip`.
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → select the unzipped
   folder.

**Option C — command line.**

```bash
chromium --load-extension=/path/to/firesync
```

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
sudo packaging/linux/install-policy.sh <extension-id> \
  https://dixonsolutions.github.io/FireSync/update.xml
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

1. **Set a FireSync passphrase.** It encrypts the vault on this device. It is not your
   Mozilla password, and there is no recovery — if you lose it, reset and reconnect.
2. **Connect your Mozilla account.** TOTP, emailed confirmation codes and Mozilla's
   new-device unblock flow are all handled. Your password is used to derive an
   authentication value locally and is then discarded; the session token is destroyed as
   soon as OAuth tokens exist.
3. **Turn off Chrome's own password manager** at `chrome://settings/autofill`. If you
   installed by policy this was done for you. Skip it and every login form gives you two
   save prompts and two dropdowns — the single most common "FireSync is broken" report.
4. **Pin FireSync to the toolbar**, so unlocking is one click.

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

Chrome only auto-updates extensions it manages — a policy-installed build, or one from the
Web Store. An unpacked or drag-installed build never updates itself, and no extension can
install a new version of itself; Chrome closes that hole deliberately.

So FireSync checks for its own releases and tells you. **Settings → Updates:**

| Setting | Default | What it does |
|---|---|---|
| Check automatically | **on** | Checks the release manifest on a timer and badges the toolbar icon |
| How often | 24 hours | Clamped to 1 hour – 14 days |
| Update manifest | the project's | Point it at your own host if you self-host or run a fork |
| Never | — | FireSync makes no requests to the update host at all |

When an update exists the toolbar icon shows **↑** and the popup offers a download link.
"Never" is absolute: even the **Check now** button will not override it.

On a policy-installed build the panel says so and Chrome does the work.

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
