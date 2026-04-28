#!/usr/bin/env bash
# Checks: verify the extension unit tests pass
set -euo pipefail
cd /Users/zshen/personal/pi-config
pnpm vitest run extensions/better-bash-tool/test/ 2>&1 | tail -20
echo "CHECKS PASSED"
