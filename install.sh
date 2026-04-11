#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/.pi/agent"

# Nix-managed files — do NOT symlink these (handled by Home Manager)
NIX_MANAGED=(
    "AGENTS.md"
    "settings.json"
    "skills"
)

# Repo items that should never be installed into ~/.pi/agent
EXCLUDED_ITEMS=(
    "install.sh"
    "self-improvements"
    "QUICKFIX.md"
)

contains_item() {
    local name="$1"
    shift
    local item
    for item in "$@"; do
        if [ "$name" = "$item" ]; then
            return 0
        fi
    done
    return 1
}

is_nix_managed() {
    contains_item "$1" "${NIX_MANAGED[@]}"
}

is_excluded_item() {
    contains_item "$1" "${EXCLUDED_ITEMS[@]}"
}

remove_repo_symlink_if_present() {
    local name="$1"
    local target_path="$TARGET/$name"
    local expected_source="$REPO_DIR/$name"

    if [ ! -L "$target_path" ]; then
        return 0
    fi

    local link_target
    link_target="$(readlink "$target_path")"

    if [ "$link_target" = "$expected_source" ]; then
        rm "$target_path"
        echo "Removed stale symlink: $name"
    fi
}

install_git_package_deps() {
    local git_root="$TARGET/git"

    if [ ! -d "$git_root" ]; then
        echo "No git package directory found at $git_root"
        return 0
    fi

    find "$git_root" -mindepth 3 -maxdepth 3 -type d -print0 | while IFS= read -r -d '' repo_dir; do
        local package_json="$repo_dir/package.json"

        if [ ! -f "$package_json" ]; then
            continue
        fi

        if [ -f "$repo_dir/pnpm-lock.yaml" ]; then
            echo "Installing pnpm dependencies in $repo_dir"
            nix shell nixpkgs#nodejs nixpkgs#pnpm -c bash -lc "cd '$repo_dir' && pnpm install"
        elif [ -f "$repo_dir/bun.lock" ] || [ -f "$repo_dir/bun.lockb" ]; then
            echo "Installing bun dependencies in $repo_dir"
            nix shell nixpkgs#nodejs nixpkgs#bun -c bash -lc "cd '$repo_dir' && bun install"
        else
            echo "Installing npm dependencies in $repo_dir"
            nix shell nixpkgs#nodejs -c bash -lc "cd '$repo_dir' && npm install"
        fi

        if grep -q '"build:pi"' "$package_json"; then
            echo "Running build:pi in $repo_dir"
            nix shell nixpkgs#nodejs nixpkgs#bun -c bash -lc "cd '$repo_dir' && bun run build:pi"
        fi
    done
}

# If ~/.pi/agent is a symlink to this repo (old install), remove it
if [ -L "$TARGET" ]; then
    echo "Removing old whole-directory symlink: $TARGET -> $(readlink "$TARGET")"
    rm "$TARGET"
fi

mkdir -p "$TARGET"

for name in "${NIX_MANAGED[@]}" "${EXCLUDED_ITEMS[@]}"; do
    remove_repo_symlink_if_present "$name"
done

# Symlink each top-level item from the repo into ~/.pi/agent/,
# skipping Nix-managed files, excluded repo items, and hidden files
for item in "$REPO_DIR"/*; do
    name="$(basename "$item")"

    # Skip Nix-managed items
    if is_nix_managed "$name"; then
        echo "Skipping (Nix-managed): $name"
        continue
    fi

    # Skip repo items that should not be installed
    if is_excluded_item "$name"; then
        echo "Skipping (excluded): $name"
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

install_git_package_deps

echo "Done. Nix manages: ${NIX_MANAGED[*]}; excluded: ${EXCLUDED_ITEMS[*]}"
