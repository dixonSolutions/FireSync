# Distribution

How to get FireSync onto a browser without publishing to the Chrome Web Store.

> **Read this first.** Stock, unmanaged **Google Chrome cannot install a self-hosted
> extension.** This is not a packaging mistake you can work around — Chrome requires a Web
> Store-issued *publisher proof* inside the CRX, and refuses anything else with
> `CRX_REQUIRED_PROOF_MISSING`. The only exemptions are enterprise policy on a **managed**
> browser, and developer mode. **Chromium and its derivatives are FireSync's primary
> target**; Chrome is supported, with conditions, and they are spelled out below.

## The matrix

| Target | Method | Works? |
|---|---|---|
| **Chromium** (primary) | Load unpacked · drag-and-drop CRX · `--load-extension` · policy | **Yes**, all four |
| ungoogled-chromium, Brave, Vivaldi | Same as Chromium | **Yes** |
| Microsoft Edge | Policy + self-host, or unpacked | **Yes** — Edge documents self-hosting |
| Chrome for Testing | `--load-extension` | **Yes** — unbranded build |
| Google Chrome, **managed** (any OS) | Self-hosted CRX + `ExtensionSettings` policy | **Yes** |
| Google Chrome, **unmanaged** | Developer mode → Load unpacked | **Yes**, with nagging and no auto-update |
| Google Chrome, **unmanaged** | Drag-and-drop CRX | **No** — `CRX_REQUIRED_PROOF_MISSING` |
| Google Chrome, **unmanaged** | Policy file alone | **No** — policy applies, extension silently ignored |
| Google Chrome ≥ 137 | `--load-extension` | **No** — removed from branded builds |

### Why Chrome refuses

Chrome verifies two independent things about a CRX3:

1. **Your signature** — proves the file has not changed since you signed it. `npm run pack`
   provides this.
2. **A Web Store publisher proof** — a second signature, issued only by Google when an
   extension is uploaded to the store. There is no way to generate one yourself.

A CRX lacking (2) is rejected outside the store. Enterprise policy on a managed browser is
the documented exemption; developer mode is the other. Chromium builds do not enforce (2) at
all, which is exactly why they are the better fit for a project that has deliberately opted
out of the store.

## Recommended paths, in order

1. **Chromium, ungoogled-chromium, Brave or Vivaldi.** Load unpacked or drop in the CRX.
   Nothing else needed. This is the supported experience.
2. **Chrome with a free Chrome Enterprise Core enrolment.** Works on a single personal
   machine, gives silent install and auto-update, and is Google's intended route for
   self-hosted extensions.
3. **Chrome in developer mode.** Fine for one machine. Chrome periodically shows a "disable
   developer mode extensions" bubble, and there is no auto-update.
4. **An unlisted Chrome Web Store listing.** Still the store, but invisible to search,
   installable by link on every OS, auto-updating, $5 once. If your objection was review
   friction rather than the store itself, this is the pragmatic answer — with the caveat
   that a password manager reusing a Mozilla OAuth client id is a genuine review risk.

## Building a signed release

```bash
npm run release
```

Runs typecheck, tests, build, then `scripts/pack.mjs`:

```
build/firesync-0.1.0.crx     the signed extension
build/update.xml             the update manifest
build/extension-id.txt       the id, and the manifest "key" to pin it
keys/firesync.pem            the signing key — generated once
```

Set the hosting base before packing so `update.xml` points somewhere real:

```bash
FIRESYNC_UPDATE_BASE=https://dl.example.com/firesync npm run pack
```

### About the signing key

`keys/firesync.pem` **is** the extension's identity. The 32-character id is derived from the
public half, and Chrome refuses an update signed with a different key. Back it up the way you
would an SSH key. It is gitignored; losing it orphans every existing install.

To keep the unpacked and signed builds on the same id during development, copy the `"key"`
line from `build/extension-id.txt` into `src/manifest.json`.

## Hosting

Two static files over HTTPS — GitHub Pages, S3, any web server:

```
https://dl.example.com/firesync/update.xml
https://dl.example.com/firesync/firesync-0.1.0.crx
```

```xml
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='YOUR_32_CHAR_ID'>
    <updatecheck codebase='https://dl.example.com/firesync/firesync-0.1.0.crx' version='0.1.0' />
  </app>
</gupdate>
```

Chrome sends no cookies with update checks and ignores `Set-Cookie`, so an unauthenticated
static file is exactly right. To ship an update: bump the version, pack, upload the CRX,
update `version` and `codebase`.

## Chromium — the primary target

```bash
chromium --load-extension=/path/to/firesync/dist
```

or `chrome://extensions` → Developer mode → **Load unpacked** → `dist/`, or simply drag
`build/firesync-0.1.0.crx` onto the extensions page. Brave, Vivaldi and ungoogled-chromium
behave the same. Policy also works, at `/etc/chromium/policies/managed/`.

## Linux

`packaging/linux/install.sh` writes the policy for whichever browsers are installed:

```bash
sudo packaging/linux/install.sh --id abcdefghijklmnopabcdefghijklmnop \
  --update-url https://dl.example.com/firesync/update.xml
```

→ `/etc/opt/chrome/policies/managed/firesync.json` and
`/etc/chromium/policies/managed/firesync.json`:

```json
{
  "ExtensionSettings": {
    "<id>": {
      "installation_mode": "normal_installed",
      "update_url": "https://dl.example.com/firesync/update.xml",
      "override_update_url": true,
      "toolbar_pin": "force_pinned"
    }
  },
  "PasswordManagerEnabled": false,
  "AutofillAddressEnabled": false,
  "AutofillCreditCardEnabled": false
}
```

On **Chromium** this is sufficient. On **Chrome**, a root-owned mandatory policy file is
generally treated as platform management and the off-store install is accepted — but
Google's documentation only spells out the requirement for Windows and macOS, so treat
Linux Chrome as *verify, don't assume*: after restarting, check `chrome://policy` shows the
policy as **OK** and `chrome://extensions` actually lists FireSync. If it does not, enrol in
Chrome Enterprise Core or use developer mode.

`normal_installed` lets the user remove FireSync. Use `force_installed` for a fleet.

## Windows

`packaging/windows/firesync-policy.reg` and `Install-FireSyncPolicy.ps1` write the same
settings under `HKLM\SOFTWARE\Policies\Google\Chrome`.

**Chrome accepts the policy but refuses the off-store install unless the device is joined to
Active Directory or Microsoft Entra ID, or the browser is enrolled in Chrome Enterprise
Core.** On an unmanaged personal machine nothing appears and no error is shown anywhere
obvious. The PowerShell script detects this and warns rather than leaving you guessing.

To enrol a single machine for free: create an enrollment token in the Chrome Enterprise Core
console and set

```
HKLM\SOFTWARE\Policies\Google\Chrome\CloudManagementEnrollmentToken
```

Then the policy above installs FireSync from your own update URL.

## macOS

`packaging/macos/com.firesync.chrome.mobileconfig` carries the same policy as a
configuration profile. Same requirement: MDM enrolment or Chrome Enterprise Core. Without
one, use Chromium or developer mode.

## Turning off Chrome's password manager

FireSync cannot disable Chrome's built-in manager from inside the extension — there is no
API — so all three policy files set:

```
PasswordManagerEnabled     = false
AutofillAddressEnabled     = false
AutofillCreditCardEnabled  = false
```

If you installed unpacked and have no policy, do it by hand at `chrome://settings/autofill`.
Skipping this gives two save prompts and two dropdowns on every login form, and is the most
common "FireSync is broken" report.

## Verifying an install

1. `chrome://policy` — `ExtensionSettings` present, status **OK**.
2. `chrome://extensions` — FireSync listed, id matching `build/extension-id.txt`.
3. `chrome://extensions` → FireSync → **service worker** → console: no errors on wake.
4. Click the toolbar icon: setup on first run, unlock thereafter.

If step 2 fails while step 1 succeeds, the browser is not considered managed and you have
hit the publisher-proof rule. Go back to [Recommended paths](#recommended-paths-in-order).
