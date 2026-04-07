#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/.pi/agent"

mkdir -p "$(dirname "$TARGET")"
ln -sfn "$REPO_DIR" "$TARGET"
echo "Linked $REPO_DIR -> $TARGET"
