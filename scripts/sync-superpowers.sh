#!/usr/bin/env bash
# scripts/sync-superpowers.sh
#
# Track and sync vendored Superpowers skills under extensions/superpowers/ against
# upstream https://github.com/obra/superpowers.
#
# Subcommands:
#   status              Pinned commit vs upstream HEAD; per-skill drift summary.
#   diff [<skill>]      Show diff between pinned upstream and vendored tree.
#                       Optional skill name narrows to one directory.
#   update [opts]       Re-vendor skills: copy upstream @ target commit, skip the
#                       ignore list, apply overlay patch, restore local-only files,
#                       then update package.json + README.md.
#
# Update options:
#   --commit <sha>      Pin to specific SHA instead of upstream HEAD.
#   --dry-run           Show plan, no writes.
#   --yes               Skip confirmation prompt.
#
# Design:
#   * Never runs git clone inside the repo worktree. Clones to /tmp cache.
#   * Reads pinned commit via jq from extensions/superpowers/package.json piVendor.
#   * Overlay model: upstream skills/ + patch + local-only files = vendored tree.
#     - overlay/pi-adaptations.patch: all intentional text patches (adaptedFrom
#       frontmatter + Claude-tool -> Pi-tool mappings).
#     - overlay/files/: local-only files that have no upstream counterpart.
#   * Intentionally-skipped upstream files are hardcoded in IGNORE_FROM_UPSTREAM.
#   * Uses git-native commands for transport, per repo policy.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
EXT_DIR="$REPO_ROOT/extensions/superpowers"
SKILLS_DIR="$EXT_DIR/skills"
OVERLAY_DIR="$EXT_DIR/overlay"
OVERLAY_PATCH="$OVERLAY_DIR/pi-adaptations.patch"
OVERLAY_FILES="$OVERLAY_DIR/files"
PKG_JSON="$EXT_DIR/package.json"
README="$EXT_DIR/README.md"

UPSTREAM_URL="https://github.com/obra/superpowers"
UPSTREAM_CLONE="/tmp/superpowers-upstream"

# Upstream files we intentionally do not vendor into the pi harness.
# Paths are relative to upstream skills/.
IGNORE_FROM_UPSTREAM=(
  "using-superpowers/references/codex-tools.md"
  "using-superpowers/references/copilot-tools.md"
  "using-superpowers/references/gemini-tools.md"
)

err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
info() { printf '\033[36m%s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[32m%s\033[0m\n' "$*" >&2; }

require() {
  command -v "$1" >/dev/null 2>&1 || { err "missing dependency: $1"; exit 1; }
}

require git
require jq
require patch
require diff

pinned_commit() {
  jq -r '.piVendor.commit' "$PKG_JSON"
}

pinned_version() {
  jq -r '.piVendor.version' "$PKG_JSON"
}

ensure_clone() {
  if [[ ! -d "$UPSTREAM_CLONE/.git" ]]; then
    info "cloning $UPSTREAM_URL -> $UPSTREAM_CLONE"
    git clone --quiet "$UPSTREAM_URL" "$UPSTREAM_CLONE"
  else
    info "fetching upstream updates"
    git -C "$UPSTREAM_CLONE" fetch --quiet --tags origin
  fi
}

resolve_ref() {
  # Resolve a ref (or "HEAD") to a full SHA from the cached clone.
  local ref="$1"
  git -C "$UPSTREAM_CLONE" rev-parse "$ref^{commit}"
}

checkout_upstream() {
  local sha="$1"
  git -C "$UPSTREAM_CLONE" checkout --quiet --detach "$sha"
}

#-----------------------------------------------------------------------------
# status
#-----------------------------------------------------------------------------
cmd_status() {
  ensure_clone
  local pinned upstream_head
  pinned="$(pinned_commit)"
  upstream_head="$(resolve_ref origin/main)"

  info "vendored pin:  $pinned ($(pinned_version))"
  info "upstream HEAD: $upstream_head"

  if [[ "$pinned" == "$upstream_head"* || "$upstream_head" == "$pinned"* ]]; then
    ok "in sync with upstream HEAD"
  else
    warn "DRIFT: upstream has moved past pinned commit"
    echo
    git -C "$UPSTREAM_CLONE" log --oneline "$pinned..$upstream_head" -- skills/ \
      | head -30
  fi

  echo
  info "rebuilding expected overlay state for drift check..."
  checkout_upstream "$pinned"
  local stage expected_tree drift_file
  stage="$(mktemp -d)"
  # shellcheck disable=SC2064  (expand $stage now, not at trap time)
  trap "rm -rf '$stage'" RETURN
  cp -R "$UPSTREAM_CLONE/skills" "$stage/skills"
  for rel in "${IGNORE_FROM_UPSTREAM[@]}"; do
    rm -f "$stage/skills/$rel"
  done
  if [[ -f "$OVERLAY_PATCH" ]]; then
    (cd "$stage/skills" && patch -p1 --quiet --no-backup-if-mismatch < "$OVERLAY_PATCH") \
      || { err "overlay patch no longer applies to pinned commit; overlay drifted"; return 1; }
    find "$stage/skills" \( -name '*.rej' -o -name '*.orig' \) -delete
  fi
  if [[ -d "$OVERLAY_FILES" ]]; then
    (cd "$OVERLAY_FILES" && find . -type f -print0) \
      | while IFS= read -r -d '' rel; do
          mkdir -p "$stage/skills/$(dirname "$rel")"
          cp "$OVERLAY_FILES/$rel" "$stage/skills/$rel"
        done
  fi
  expected_tree="$stage/skills"
  drift_file=$(mktemp)
  diff -rq "$expected_tree" "$SKILLS_DIR" 2>/dev/null > "$drift_file" || true
  if [[ ! -s "$drift_file" ]]; then
    ok "vendored tree matches upstream@pinned + overlay (clean)"
  else
    warn "UNEXPECTED DRIFT (vendored tree diverges from upstream+overlay):"
    cat "$drift_file"
    warn "either someone edited skills/ directly, or overlay is out of date."
    warn "fix: edit skills/ and regenerate overlay, or revert skills/ and rerun update."
  fi
  rm -f "$drift_file"
}

#-----------------------------------------------------------------------------
# diff
#-----------------------------------------------------------------------------
cmd_diff() {
  local target_skill="${1:-}"
  ensure_clone
  local pinned
  pinned="$(pinned_commit)"
  checkout_upstream "$pinned"

  local ups_skills="$UPSTREAM_CLONE/skills"
  if [[ -n "$target_skill" ]]; then
    if [[ ! -d "$SKILLS_DIR/$target_skill" ]]; then
      err "unknown skill: $target_skill"
      exit 1
    fi
    diff -urN "$ups_skills/$target_skill" "$SKILLS_DIR/$target_skill" || true
  else
    diff -urN "$ups_skills" "$SKILLS_DIR" || true
  fi
}

#-----------------------------------------------------------------------------
# update
#-----------------------------------------------------------------------------
cmd_update() {
  local target_ref="origin/main"
  local dry_run=0
  local assume_yes=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --commit)  target_ref="$2"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      --yes)     assume_yes=1; shift ;;
      *) err "unknown option: $1"; exit 1 ;;
    esac
  done

  ensure_clone
  local new_sha cur_sha
  new_sha="$(resolve_ref "$target_ref")"
  cur_sha="$(resolve_ref "$(pinned_commit)")"

  info "current pin:  $cur_sha"
  info "updating to:  $new_sha  ($target_ref)"

  if [[ "$new_sha" == "$cur_sha" ]]; then
    if [[ "$assume_yes" -ne 1 ]]; then
      warn "already at target commit; re-run anyway? (y/N)"
      read -r ans
      [[ "$ans" == "y" || "$ans" == "Y" ]] || { ok "no changes"; return 0; }
    fi
  fi

  # Show what upstream changes are landing before we touch anything.
  if [[ "$new_sha" != "$cur_sha" ]]; then
    info "upstream commits to land (skills/ paths only):"
    git -C "$UPSTREAM_CLONE" log --oneline "$cur_sha..$new_sha" -- skills/ | head -40
    echo
    info "upstream files changing (skills/ only):"
    git -C "$UPSTREAM_CLONE" diff --name-only "$cur_sha..$new_sha" -- skills/ | head -60
    echo
  fi

  if [[ "$dry_run" -eq 1 ]]; then
    ok "dry-run: no files written"
    return 0
  fi

  if [[ "$assume_yes" -ne 1 ]]; then
    warn "about to overwrite $SKILLS_DIR. Proceed? (y/N)"
    read -r ans
    [[ "$ans" == "y" || "$ans" == "Y" ]] || { err "aborted"; exit 1; }
  fi

  # Stage a fresh skills tree in a scratch directory, then atomically swap.
  local stage
  stage="$(mktemp -d)"
  trap "rm -rf '$stage'" EXIT

  checkout_upstream "$new_sha"
  cp -R "$UPSTREAM_CLONE/skills" "$stage/skills"

  # Drop upstream files we intentionally do not vendor.
  for rel in "${IGNORE_FROM_UPSTREAM[@]}"; do
    rm -f "$stage/skills/$rel"
  done

  # Apply overlay patch.
  if [[ -f "$OVERLAY_PATCH" ]]; then
    info "applying overlay patch"
    pushd "$stage/skills" >/dev/null
    if ! patch -p1 --quiet --no-backup-if-mismatch < "$OVERLAY_PATCH"; then
      popd >/dev/null
      err "overlay patch failed to apply cleanly."
      err "upstream likely changed text that our overlay patches."
      err "inspect conflicts under $stage/skills and regenerate overlay."
      exit 1
    fi
    # Remove any .rej / .orig leftovers just in case.
    find "$stage/skills" \( -name '*.rej' -o -name '*.orig' \) -delete
    popd >/dev/null
  fi

  # Copy local-only overlay files over.
  if [[ -d "$OVERLAY_FILES" ]]; then
    info "copying local-only overlay files"
    (cd "$OVERLAY_FILES" && find . -type f -print0) \
      | while IFS= read -r -d '' rel; do
          mkdir -p "$stage/skills/$(dirname "$rel")"
          cp "$OVERLAY_FILES/$rel" "$stage/skills/$rel"
        done
  fi

  # Atomic swap: replace $SKILLS_DIR.
  info "swapping into $SKILLS_DIR"
  rm -rf "$SKILLS_DIR"
  mv "$stage/skills" "$SKILLS_DIR"

  # Update package.json piVendor.commit (preserve version if tag lookup fails).
  local new_version
  new_version="$(git -C "$UPSTREAM_CLONE" describe --tags --abbrev=0 "$new_sha" 2>/dev/null | sed 's/^v//' || true)"
  if [[ -z "$new_version" ]]; then
    new_version="$(pinned_version)"
    warn "no tag at $new_sha; keeping version $new_version"
  fi
  local short_sha="${new_sha:0:8}"
  local tmp_pkg
  tmp_pkg="$(mktemp)"
  awk -v c="$short_sha" -v v="$new_version" '
    /"commit":/ { sub(/"commit": "[^"]+"/, "\"commit\": \"" c "\"") }
    /"version":/ { sub(/"version": "[^"]+"/, "\"version\": \"" v "\"") }
    { print }
  ' "$PKG_JSON" > "$tmp_pkg"
  mv "$tmp_pkg" "$PKG_JSON"
  info "updated $PKG_JSON piVendor -> $short_sha ($new_version)"

  # Update README.md version/commit lines.
  if [[ -f "$README" ]]; then
    local today
    today="$(date +%Y-%m-%d)"
    # Portable in-place edit (macOS/Linux): write to tmp then move.
    local tmp_readme
    tmp_readme="$(mktemp)"
    awk -v v="$new_version" -v c="$short_sha" -v d="$today" '
      /^- \*\*Version:\*\* /    { print "- **Version:** " v; next }
      /^- \*\*Commit:\*\* /     { print "- **Commit:** " c; next }
      /^- \*\*Last synced:\*\*/ { print "- **Last synced:** " d; next }
      { print }
    ' "$README" > "$tmp_readme"
    mv "$tmp_readme" "$README"
    info "updated $README"
  fi

  ok "sync complete: $short_sha ($new_version)"
  warn "verify with:  pnpm test:extensions && pnpm lint:typecheck"
}

#-----------------------------------------------------------------------------
# entry
#-----------------------------------------------------------------------------
usage() {
  sed -n '2,30p' "$0"
}

main() {
  local sub="${1:-}"
  shift || true
  case "$sub" in
    status) cmd_status "$@" ;;
    diff)   cmd_diff "$@" ;;
    update) cmd_update "$@" ;;
    -h|--help|help|"") usage ;;
    *) err "unknown subcommand: $sub"; usage; exit 1 ;;
  esac
}

main "$@"
