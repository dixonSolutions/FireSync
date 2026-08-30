#!/usr/bin/env bash
#
# Install FireSync on a Chromium-family browser on Linux, without Developer mode.
#
#   sudo ./install.sh                 # detect browsers, install, auto-updating
#   sudo ./install.sh --method drop   # use the external-extensions drop-in instead
#   sudo ./install.sh --uninstall
#
# Two mechanisms are available, both documented by Google and neither requiring
# Developer mode:
#
#   policy  (default)  A managed-policy JSON in /etc/<browser>/policies/managed.
#                      Installs, auto-updates from the update manifest, and also
#                      turns off the browser's own password manager so you do not
#                      get two save prompts on every login form.
#
#   drop               An external-extensions JSON in the browser's extensions
#                      directory. Lighter — it only installs the extension — and
#                      on Linux it installs with no prompt at all.
#
# On Google Chrome specifically, off-store installs additionally require the
# browser to be managed (AD / Entra ID / MDM / Chrome Enterprise Core). On
# Chromium and its derivatives there is no such requirement.

set -euo pipefail

EXTENSION_ID="${FIRESYNC_EXTENSION_ID:-dojcccmfoafidklfhceikajbcahaamgm}"
UPDATE_URL="${FIRESYNC_UPDATE_URL:-https://dixonsolutions.github.io/FireSync/update.xml}"
METHOD="policy"
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --method)      METHOD="${2:-}"; shift 2 ;;
    --id)          EXTENSION_ID="${2:-}"; shift 2 ;;
    --update-url)  UPDATE_URL="${2:-}"; shift 2 ;;
    --uninstall)   UNINSTALL=1; shift ;;
    -h|--help)     sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ "$METHOD" == "policy" || "$METHOD" == "drop" ]] || { echo "--method must be policy or drop" >&2; exit 2; }
[[ "$EXTENSION_ID" =~ ^[a-p]{32}$ ]] || { echo "'$EXTENSION_ID' is not a valid extension id" >&2; exit 2; }
[[ "$UPDATE_URL" == https://* ]] || { echo "the update URL must be https" >&2; exit 2; }
[[ $EUID -eq 0 ]] || { echo "run this with sudo — it writes under /etc and /usr/share" >&2; exit 1; }

# name | policy dir | external-extensions dir | detect path
BROWSERS=(
  "Chromium|/etc/chromium/policies/managed|/usr/share/chromium/extensions|/usr/bin/chromium"
  "Chromium|/etc/chromium/policies/managed|/usr/share/chromium/extensions|/usr/bin/chromium-browser"
  "Google Chrome|/etc/opt/chrome/policies/managed|/opt/google/chrome/extensions|/usr/bin/google-chrome"
  "Brave|/etc/brave/policies/managed|/usr/share/brave/extensions|/usr/bin/brave-browser"
  "Vivaldi|/etc/vivaldi/policies/managed|/usr/share/vivaldi/extensions|/usr/bin/vivaldi"
  "Microsoft Edge|/etc/opt/edge/policies/managed|/opt/microsoft/msedge/extensions|/usr/bin/microsoft-edge"
)

write_policy() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/firesync.json" <<JSON
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
  chmod 644 "$dir/firesync.json"
  echo "  policy   $dir/firesync.json"
}

write_drop() {
  local dir="$1"
  mkdir -p "$dir"
  # external_update_url keeps it auto-updating; external_crx would pin a file.
  printf '{ "external_update_url": "%s" }\n' "$UPDATE_URL" > "$dir/$EXTENSION_ID.json"
  chmod 644 "$dir/$EXTENSION_ID.json"
  echo "  drop-in  $dir/$EXTENSION_ID.json"
}

found=0
for entry in "${BROWSERS[@]}"; do
  IFS='|' read -r name policy_dir drop_dir binary <<< "$entry"
  [[ -x "$binary" ]] || continue
  found=1

  if [[ $UNINSTALL -eq 1 ]]; then
    echo "$name:"
    rm -f "$policy_dir/firesync.json" && echo "  removed  $policy_dir/firesync.json" || true
    rm -f "$drop_dir/$EXTENSION_ID.json" && echo "  removed  $drop_dir/$EXTENSION_ID.json" || true
    continue
  fi

  echo "$name:"
  if [[ "$METHOD" == "policy" ]]; then write_policy "$policy_dir"; else write_drop "$drop_dir"; fi
done

if [[ $found -eq 0 ]]; then
  echo "No Chromium-family browser found in /usr/bin." >&2
  echo "Pass --method drop and create the directory yourself, or install unpacked." >&2
  exit 1
fi

if [[ $UNINSTALL -eq 1 ]]; then
  echo
  echo "Removed. Restart the browser; FireSync will be uninstalled with it."
  exit 0
fi

cat <<NEXT

Done. Restart the browser.

  - FireSync installs itself on startup. Developer mode is not needed.
  - Check chrome://extensions — it should be listed and enabled.
  - Check chrome://policy if you used the default method.

To remove: sudo $0 --uninstall
NEXT
