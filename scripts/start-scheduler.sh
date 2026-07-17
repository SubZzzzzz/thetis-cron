#!/usr/bin/env bash
#
# Start the thetis-cron scheduler daemon.
# Used by systemd service pi-cron-scheduler.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$EXT_DIR"

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  npm install --silent
fi

# Launch scheduler with tsx
exec npx tsx scheduler.ts
