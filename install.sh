#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/.pi/agent"
SKILLS_SOURCE="$HOME/.omp/agent/skills"
SKILLS_TARGET="$TARGET/skills"

mkdir -p "$(dirname "$TARGET")"

if [ -d "$TARGET" ] && [ ! -L "$TARGET" ]; then
  BROKEN_TARGET="$TARGET/$(basename "$REPO_DIR")"

  if [ -L "$BROKEN_TARGET" ] && [ "$(readlink "$BROKEN_TARGET")" = "$REPO_DIR" ]; then
    rm "$BROKEN_TARGET"
  fi

  rmdir "$TARGET" 2>/dev/null || {
    echo "Refusing to replace non-empty directory at $TARGET" >&2
    exit 1
  }
fi

ln -sfnT "$REPO_DIR" "$TARGET"
echo "Linked $REPO_DIR -> $TARGET"

if [ -d "$SKILLS_TARGET" ] && [ ! -L "$SKILLS_TARGET" ]; then
  rmdir "$SKILLS_TARGET" 2>/dev/null || {
    echo "Refusing to replace non-empty directory at $SKILLS_TARGET" >&2
    exit 1
  }
fi

ln -sfnT "$SKILLS_SOURCE" "$SKILLS_TARGET"
echo "Linked $SKILLS_SOURCE -> $SKILLS_TARGET"
