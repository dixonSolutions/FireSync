#!/usr/bin/env bash
# Install the FireSync bridge for the current user.
#
#   ./install.sh <extension-id>
#   ./install.sh --uninstall
#
# Writes a native messaging host manifest into every Chromium-family browser
# directory that exists. Nothing is installed system-wide, nothing runs as root,
# and the host itself is started only when the extension asks for it.

set -euo pipefail

HOST_NAME="com.firesync.bridge"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_PATH="$HERE/host.mjs"

targets() {
  case "$(uname -s)" in
    Darwin)
      printf '%s\n' \
        "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
        "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" \
        "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
        "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
      ;;
    *)
      printf '%s\n' \
        "$HOME/.config/google-chrome/NativeMessagingHosts" \
        "$HOME/.config/chromium/NativeMessagingHosts" \
        "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
        "$HOME/.config/microsoft-edge/NativeMessagingHosts" \
        "$HOME/.config/vivaldi/NativeMessagingHosts"
      ;;
  esac
}

if [[ "${1:-}" == "--uninstall" ]]; then
  while IFS= read -r dir; do
    [[ -f "$dir/$HOST_NAME.json" ]] || continue
    rm -f "$dir/$HOST_NAME.json"
    echo "removed $dir/$HOST_NAME.json"
  done < <(targets)
  echo "Bridge uninstalled. FireSync keeps working without it."
  exit 0
fi

EXTENSION_ID="${1:-}"
if [[ -z "$EXTENSION_ID" ]]; then
  echo "usage: $0 <extension-id>            (find it at chrome://extensions)" >&2
  echo "       $0 --uninstall" >&2
  exit 2
fi
if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "error: '$EXTENSION_ID' is not a valid 32-character extension id" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not on PATH; the bridge needs Node 22.5 or newer" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 5) )); then
  echo "error: node $(node -v) is too old; the bridge needs 22.5+ for node:sqlite" >&2
  exit 1
fi

chmod +x "$HOST_PATH"

installed=0
while IFS= read -r dir; do
  parent="$(dirname "$dir")"
  [[ -d "$parent" ]] || continue
  mkdir -p "$dir"
  cat > "$dir/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "FireSync bridge — local Firefox profile import, OS keychain, loopback OAuth",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON
  chmod 644 "$dir/$HOST_NAME.json"
  echo "installed $dir/$HOST_NAME.json"
  installed=1
done < <(targets)

if [[ $installed -eq 0 ]]; then
  echo "error: no Chromium-family browser directories found" >&2
  exit 1
fi

echo
echo "Checking the host runs:"
node "$HOST_PATH" --self-test | tail -3
echo
echo "Now open FireSync's settings and turn on the local bridge."
