# Native npm modules like node-pty may fall back to local compilation in the install shell.
# Keep a small shared toolchain available for all Node package-manager installs.
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/.pi/agent"
EXTENSIONS_TARGET="$TARGET/extensions"
REPO_EXTENSIONS_DIR="$REPO_DIR/extensions"
SKILLS_TARGET="$TARGET/skills"
REPO_SKILLS_DIR="$REPO_DIR/skills"

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

# Extension-dir entries that are NOT pi extensions — do NOT symlink.
# Docs, empty placeholders, and leftover runtime junk. lib/ and guardrails.json
# stay linked: lib is imported by other extensions, and pi-guardrails reads
# ~/.pi/agent/extensions/guardrails.json.
EXCLUDED_EXTENSION_ITEMS=(
  "AGENTS.md"
  "CONVENTIONS.md"
  "codex"
)

# Top-level items to symlink into ~/.pi/agent (allowlist).
# Everything else (test infra, build config, node_modules, runtime state, etc.) stays out of repo-managed symlinks.
ALLOWED_ITEMS=(
  "agents"
  "modes"
  "lsp.json"
  "caveman.json"
  "session-summary.json"
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

is_excluded_extension() {
  contains_item "$1" "${EXCLUDED_EXTENSION_ITEMS[@]}"
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
        if [ ! -e "$REPO_EXTENSIONS_DIR/$name" ] || is_nix_managed_extension "$name" || is_excluded_extension "$name"; then
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

    if is_excluded_extension "$name"; then
      echo "Skipping extension (not a pi extension): $name"
      continue
    fi

    target_path="$EXTENSIONS_TARGET/$name"
    rm -rf "$target_path"
    ln -s "$item" "$target_path"
    echo "Linked extension $name"
  done
}

sync_repo_skills() {
  local item
  local name
  local target_path
  local link_target

  if [ ! -d "$REPO_SKILLS_DIR" ]; then
    return 0
  fi

  mkdir -p "$SKILLS_TARGET"

  # Clean stale repo-managed symlinks (skip Nix-store symlinks — they point elsewhere)
  find "$SKILLS_TARGET" -mindepth 1 -maxdepth 1 -type l -print0 | while IFS= read -r -d '' item; do
    name="$(basename "$item")"
    link_target="$(readlink "$item")"

    case "$link_target" in
      "$REPO_SKILLS_DIR"/*)
        if [ ! -e "$REPO_SKILLS_DIR/$name" ]; then
          rm "$item"
          echo "Removed stale skill symlink: $name"
        fi
        ;;
    esac
  done

  for item in "$REPO_SKILLS_DIR"/*; do
    [ -e "$item" ] || continue
    [ -d "$item" ] || continue

    name="$(basename "$item")"
    target_path="$SKILLS_TARGET/$name"

    # If a non-symlink (e.g., Nix-managed real dir) sits at this name, leave it alone
    if [ -e "$target_path" ] && [ ! -L "$target_path" ]; then
      echo "Skipping skill (non-symlink at target, likely Nix-managed): $name"
      continue
    fi

    # If a symlink exists but doesn't point into our repo, leave it alone (Nix-store link)
    if [ -L "$target_path" ]; then
      link_target="$(readlink "$target_path")"
      case "$link_target" in
        "$REPO_SKILLS_DIR"/*) ;;
        *)
          echo "Skipping skill (symlink points outside repo, likely Nix-managed): $name"
          continue
          ;;
      esac
      rm "$target_path"
    fi

    ln -s "$item" "$target_path"
    echo "Linked skill $name"
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

# Phase 2 hard fork: rename pre-fork upstream package to @panda/pi-subagents.
# Defensive cleanup of any legacy pi-installed symlink under ~/.pi/agent/git/.
# Subagent itself stays symlinked through sync_repo_extensions ->
# $EXTENSIONS_TARGET/subagent, so no positive recreation is needed here.
remove_legacy_git_subagent_symlinks() {
  local legacy_scope="@tintinweb"
  local legacy_package="pi-subagents"
  local legacy_path="$TARGET/git/$legacy_scope/$legacy_package"
  if [ -L "$legacy_path" ]; then
    rm "$legacy_path"
    echo "Removed legacy git symlink: $legacy_scope/$legacy_package"
  elif [ -e "$legacy_path" ]; then
    echo "Note: legacy path exists but is not a symlink: $legacy_path (leaving alone)"
  fi
  local legacy_dir="$TARGET/git/$legacy_scope"
  if [ -d "$legacy_dir" ] && [ -z "$(ls -A "$legacy_dir" 2>/dev/null)" ]; then
    rmdir "$legacy_dir"
    echo "Removed empty legacy scope directory: $legacy_scope"
  fi
}
remove_legacy_git_subagent_symlinks

# Phase 2 hard fork: defensive cleanup of any legacy pi-installed symlink for
# the tasks extension under ~/.pi/agent/git/. Tasks extension itself stays
# symlinked through sync_repo_extensions -> $EXTENSIONS_TARGET/tasks, so no
# positive recreation is needed here.
remove_legacy_git_tasks_symlinks() {
  local legacy_scope="@tintinweb"
  local legacy_package="pi-tasks"
  local legacy_path="$TARGET/git/$legacy_scope/$legacy_package"
  if [ -L "$legacy_path" ]; then
    rm "$legacy_path"
    echo "Removed legacy git symlink: $legacy_scope/$legacy_package"
  elif [ -e "$legacy_path" ]; then
    echo "Note: legacy path exists but is not a symlink: $legacy_path (leaving alone)"
  fi
  local legacy_dir="$TARGET/git/$legacy_scope"
  if [ -d "$legacy_dir" ] && [ -z "$(ls -A "$legacy_dir" 2>/dev/null)" ]; then
    rmdir "$legacy_dir"
    echo "Removed empty legacy scope directory: $legacy_scope"
  fi
}
remove_legacy_git_tasks_symlinks

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

  target_path="$TARGET/$name"
  if [ -e "$target_path" ] || [ -L "$target_path" ]; then
    rm -rf "$target_path"
  fi
  ln -s "$local_path" "$target_path"
  echo "Linked $name"
done

sync_repo_extensions
sync_repo_skills
install_git_package_deps

echo "Done. Nix manages: ${NIX_MANAGED[*]}; extension entries: ${NIX_MANAGED_EXTENSIONS[*]}; excluded extension items: ${EXCLUDED_EXTENSION_ITEMS[*]}; allowed: ${ALLOWED_ITEMS[*]}"
