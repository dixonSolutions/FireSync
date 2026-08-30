#!/usr/bin/env bash
# Install the FireSync policy for Chrome and/or Chromium on Linux.
#
#   sudo ./install-policy.sh <extension-id> <update-url>
#
# Off-store installation on Linux needs no domain join and no MDM: dropping a
# JSON file into the managed policy directory is enough.

set -euo pipefail

EXTENSION_ID="${1:-}"
UPDATE_URL="${2:-}"

if [[ -z "$EXTENSION_ID" || -z "$UPDATE_URL" ]]; then
  echo "usage: sudo $0 <extension-id> <https://host/firesync/update.xml>" >&2
  exit 2
fi

if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "error: '$EXTENSION_ID' is not a valid 32-character extension id" >&2
  exit 2
fi

if [[ "$UPDATE_URL" != https://* ]]; then
  echo "error: the update URL must be https" >&2
  exit 2
fi

if [[ $EUID -ne 0 ]]; then
  echo "error: run this with sudo — it writes to /etc" >&2
  exit 1
fi

read -r -d '' POLICY <<JSON || true
{
  "ExtensionSettings": {
    "$EXTENSION_ID": {
      "installation_mode": "normal_installed",
      "update_url": "$UPDATE_URL",
      "override_update_url": true,
      "toolbar_pin": "force_pinned"
    }
  },
  "PasswordManagerEnabled": false,
  "AutofillAddressEnabled": false,
  "AutofillCreditCardEnabled": false
}
JSON

installed=0
for dir in /etc/opt/chrome/policies/managed /etc/chromium/policies/managed; do
  browser_root="$(dirname "$(dirname "$dir")")"
  if [[ -d "$browser_root" ]] || [[ -d "$dir" ]]; then
    mkdir -p "$dir"
    printf '%s\n' "$POLICY" > "$dir/firesync.json"
    chmod 644 "$dir/firesync.json"
    echo "installed $dir/firesync.json"
    installed=1
  fi
done

if [[ $installed -eq 0 ]]; then
  mkdir -p /etc/opt/chrome/policies/managed
  printf '%s\n' "$POLICY" > /etc/opt/chrome/policies/managed/firesync.json
  echo "installed /etc/opt/chrome/policies/managed/firesync.json"
fi

cat <<'NEXT'

Restart the browser, then confirm at chrome://policy that ExtensionSettings is
applied and at chrome://extensions that FireSync appears.

To uninstall: remove the firesync.json files and restart.
NEXT
