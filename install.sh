#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/.pi/agent"

# Nix-managed files — do NOT symlink these (handled by Home Manager)
NIX_MANAGED=(
    "AGENTS.md"
    "settings.json"
    "skills"
)

is_nix_managed() {
    local name="$1"
    for managed in "${NIX_MANAGED[@]}"; do
        if [ "$name" = "$managed" ]; then
            return 0
        fi
    done
    return 1
}

# If ~/.pi/agent is a symlink to this repo (old install), remove it
if [ -L "$TARGET" ]; then
    echo "Removing old whole-directory symlink: $TARGET -> $(readlink "$TARGET")"
    rm "$TARGET"
fi

mkdir -p "$TARGET"

# Symlink each top-level item from the repo into ~/.pi/agent/,
# skipping Nix-managed files, hidden files, and install.sh itself
for item in "$REPO_DIR"/*; do
    name="$(basename "$item")"

    # Skip Nix-managed items
    if is_nix_managed "$name"; then
        echo "Skipping (Nix-managed): $name"
        continue
    fi

    # Skip install.sh and self-improvements/
    if [ "$name" = "install.sh" ] || [ "$name" = "self-improvements" ]; then
        continue
    fi

    # Create or update the symlink
    ln -sfn "$item" "$TARGET/$name"
    echo "Linked $name"
done

# Also symlink dotfiles that aren't .git or .gitignore
for item in "$REPO_DIR"/.*; do
    name="$(basename "$item")"

    # Skip . .. .git .gitignore .pi
    case "$name" in
    . | .. | .git | .gitignore | .pi) continue ;;
    esac

    ln -sfn "$item" "$TARGET/$name"
    echo "Linked $name"
done

echo "Done. Nix manages: ${NIX_MANAGED[*]}"
