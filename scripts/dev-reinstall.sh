#!/usr/bin/env bash
# Recompile + reinstall the extension into VS Code for fast local iteration.
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root (script lives in scripts/)

EXT_ID="local.markdown-wysiwyg-editor"
CLI="${CODE_CLI:-code}"   # override: CODE_CLI=cursor ./dev-reinstall.sh

if ! command -v "$CLI" >/dev/null 2>&1; then
  echo "error: '$CLI' CLI not found on PATH. Set CODE_CLI to your editor CLI (e.g. cursor)." >&2
  exit 1
fi

echo "==> Building (esbuild)"
npm run build

echo "==> Packaging vsix (vsce)"
rm -f ./*.vsix
npm run package

VSIX="$(ls -t ./*.vsix | head -n1)"
if [ -z "${VSIX:-}" ]; then
  echo "error: no .vsix produced" >&2
  exit 1
fi

echo "==> Installing $VSIX into $CLI"
"$CLI" --install-extension "$VSIX" --force

echo
echo "Done. Extension '$EXT_ID' installed from $VSIX"
echo "Reload the window to pick it up: Cmd+Shift+P -> 'Developer: Reload Window'"
