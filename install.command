#!/usr/bin/env bash
# Odysseus_Code installer — double-click on macOS (or run on Linux).
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  python3 install.py "$@"
else
  echo "Python 3 not found. Install it, then run: python3 install.py"
fi
echo
read -r -p "Press Enter to close..."
