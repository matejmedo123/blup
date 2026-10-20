#!/usr/bin/env bash
# Run the three README walkthroughs (plus the add-ons) offline. Same as: python3 scripts/demo.py
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 scripts/demo.py "$@"
