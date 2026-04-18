# Native npm modules like node-pty may fall back to local compilation in the install shell.
# Keep a small shared toolchain available for all Node package-manager installs.
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/.pi/agent"
EXTENSIONS_TARGET="$TARGET/extensions"
REPO_EXTENSIONS_DIR="$REPO_DIR/extensions"

# Nix-managed files — do NOT symlink these (handled by Home Manager)
NIX_MANAGED=(
    "AGENTS.md"
    "settings.json"
    "skills"
)

# Nix-managed extension entries — do NOT symlink these
NIX_MANAGED_EXTENSIONS=(
    "rtk.ts"
)

# Top-level items to symlink into ~/.pi/agent (allowlist).
# Everything else (test infra, build config, node_modules, runtime state, etc.) stays out of repo-managed symlinks.
ALLOWED_ITEMS=(
    "agents"
    "docs"
    "git"
    "lsp.json"
    "mcp.json"
    "plans"
    "README.md"
    "scripts"
    "themes"
)

NODE_BUILD_SHELL=(
    nix shell
    nixpkgs#nodejs
    nixpkgs#python3
    nixpkgs#gnumake
    nixpkgs#gcc
    nixpkgs#pkg-config
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

is_nix_managed_extension() {
    contains_item "$1" "${NIX_MANAGED_EXTENSIONS[@]}"
}

is_allowed_item() {
    contains_item "$1" "${ALLOWED_ITEMS[@]}"
}

remove_legacy_nested_symlink() {
    local path="$1"
    local expected_target="$2"
    local label="$3"

    if [ -L "$path" ] && [ "$(readlink "$path")" = "$expected_target" ]; then
        rm "$path"
        echo "Removed legacy nested symlink: $label"
    fi
}

migrate_repo_sessions_to_target() {
    local repo_sessions="$REPO_DIR/sessions"
    local target_sessions="$TARGET/sessions"

    mkdir -p "$target_sessions"
    remove_legacy_nested_symlink "$target_sessions/sessions" "$repo_sessions" "sessions/sessions"

    if [ -d "$repo_sessions" ]; then
        cp -a "$repo_sessions"/. "$target_sessions"/
        rm -rf "$repo_sessions"
        echo "Migrated repo-local session data into $target_sessions"
    fi
}

sync_repo_extensions() {
    local item
    local name
    local target_path
    local link_target

    mkdir -p "$EXTENSIONS_TARGET"

    find "$EXTENSIONS_TARGET" -mindepth 1 -maxdepth 1 -type l -print0 | while IFS= read -r -d '' item; do
        name="$(basename "$item")"
        link_target="$(readlink "$item")"

        case "$link_target" in
        "$REPO_EXTENSIONS_DIR"/*)
            if [ ! -e "$REPO_EXTENSIONS_DIR/$name" ] || is_nix_managed_extension "$name"; then
                rm "$item"
                echo "Removed stale extension symlink: $name"
            fi
            ;;
        esac
    done

    for item in "$REPO_EXTENSIONS_DIR"/*; do
        [ -e "$item" ] || continue

        name="$(basename "$item")"

        if is_nix_managed_extension "$name"; then
            echo "Skipping extension (Nix-managed): $name"
            continue
        fi

        target_path="$EXTENSIONS_TARGET/$name"
        rm -rf "$target_path"
        ln -s "$item" "$target_path"
        echo "Linked extension $name"
    done
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
            "${NODE_BUILD_SHELL[@]}" nixpkgs#pnpm -c bash -lc "cd '$repo_dir' && pnpm install --ignore-workspace"
        elif [ -f "$repo_dir/bun.lock" ] || [ -f "$repo_dir/bun.lockb" ]; then
            echo "Installing bun dependencies in $repo_dir"
            "${NODE_BUILD_SHELL[@]}" nixpkgs#bun -c bash -lc "cd '$repo_dir' && bun install"
        else
            echo "Installing npm dependencies in $repo_dir"
            "${NODE_BUILD_SHELL[@]}" -c bash -lc "cd '$repo_dir' && npm install"
        fi

        if grep -q '"build:pi"' "$package_json"; then
            echo "Running build:pi in $repo_dir"
            "${NODE_BUILD_SHELL[@]}" nixpkgs#bun -c bash -lc "cd '$repo_dir' && bun run build:pi"
        fi
    done
}

# If ~/.pi/agent is a symlink to this repo (old install), remove it
if [ -L "$TARGET" ]; then
    echo "Removing old whole-directory symlink: $TARGET -> $(readlink "$TARGET")"
    rm "$TARGET"
fi

mkdir -p "$TARGET"

# Clean up stale symlinks for items no longer in allowlist or no longer present in repo
# (e.g., items that were previously symlinked under the old exclude-list approach)
find "$TARGET" -mindepth 1 -maxdepth 1 -type l -print0 | while IFS= read -r -d '' item; do
    name="$(basename "$item")"
    link_target="$(readlink "$item")"

    # Only clean up symlinks pointing back to this repo
    case "$link_target" in
    "$REPO_DIR"/*)
        if is_allowed_item "$name"; then
            if [ ! -e "$REPO_DIR/$name" ]; then
                rm "$item"
                echo "Removed stale missing-item symlink: $name"
            fi
        elif ! is_nix_managed "$name"; then
            rm "$item"
            echo "Removed stale symlink: $name"
        fi
        ;;
    esac
done

migrate_repo_sessions_to_target


# Symlink only allowlisted items from repo into ~/.pi/agent/
for name in "${ALLOWED_ITEMS[@]}"; do
    local_path="$REPO_DIR/$name"

    # Skip items that don't exist in the repo
    if [ ! -e "$local_path" ]; then
        echo "Skipping (not in repo): $name"
        continue
    fi

    # Skip Nix-managed items
    if is_nix_managed "$name"; then
        echo "Skipping (Nix-managed): $name"
        continue
    fi

    ln -sfn "$local_path" "$TARGET/$name"
    echo "Linked $name"
done

sync_repo_extensions
install_git_package_deps

echo "Done. Nix manages: ${NIX_MANAGED[*]}; extension entries: ${NIX_MANAGED_EXTENSIONS[*]}; allowed: ${ALLOWED_ITEMS[*]}"
