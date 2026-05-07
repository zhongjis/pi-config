#!/usr/bin/env bash
# scripts/sync-gitnexus-resources.sh
# Manual sync of vendored GitNexus skills against installed binary templates.
# Runs gitnexus analyze in a scratch directory; diffs output against the vendored tree;
# prompts before applying. Never runs in the repo working tree.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
VENDORED_SKILLS="$REPO_ROOT/extensions/gitnexus/skills"
VERSION_FILE="$VENDORED_SKILLS/VERSION"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/sync-gitnexus-resources.sh [--dry-run]

Sync vendored GitNexus skill templates against the installed gitnexus binary.
Runs analyze in a scratch tmpdir; prompts before applying diffs into
extensions/gitnexus/skills/. Never touches the repo working tree without confirmation.

Options:
  --dry-run   Show diffs without applying or prompting.
  -h, --help  Show this help.

Exit codes:
  0  success or no-op
  1  upstream analyze failed
  2  user declined apply
  3  other error
EOF
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 3 ;;
  esac
done

command -v gitnexus >/dev/null || { echo "gitnexus not on PATH" >&2; exit 3; }
BINARY_VERSION="$(gitnexus --version | head -1 | tr -d '[:space:]')"
echo "Installed binary: gitnexus $BINARY_VERSION"

SCRATCH="$(mktemp -d -t gitnexus-sync.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

echo "Scratch dir: $SCRATCH"
cd "$SCRATCH"
git init --quiet
printf '{"name":"gitnexus-sync-scratch","version":"0.0.0"}\n' > package.json
mkdir -p src
printf '// placeholder\nexport const x = 1;\n' > src/index.ts
git add -A && git commit --quiet -m init

echo "Running gitnexus analyze --force --skills ..."
if ! gitnexus analyze --force --skills >/dev/null 2>&1; then
  echo "gitnexus analyze failed in scratch dir" >&2
  exit 1
fi

# Binary writes to .claude/skills/gitnexus/ inside the scratch dir.
SCRATCH_SKILLS="$SCRATCH/.claude/skills/gitnexus"
if [[ ! -d "$SCRATCH_SKILLS" ]]; then
  echo "gitnexus analyze ran but produced no .claude/skills/gitnexus/ output" >&2
  exit 1
fi

echo
echo "=== Skill diff summary ==="
CHANGED=0
ADDED=0
REMOVED=0

# Compare each scratch skill vs vendored.
for scratch_skill_dir in "$SCRATCH_SKILLS"/*/; do
  skill_name="$(basename "$scratch_skill_dir")"
  vendored_path="$VENDORED_SKILLS/$skill_name/SKILL.md"
  scratch_path="$scratch_skill_dir/SKILL.md"
  if [[ ! -f "$vendored_path" ]]; then
    echo "+ ADDED  $skill_name"
    ADDED=$((ADDED+1))
  elif ! diff -q "$scratch_path" "$vendored_path" >/dev/null 2>&1; then
    echo "~ MODIFIED $skill_name"
    CHANGED=$((CHANGED+1))
  fi
done

# Detect removed (vendored but not in scratch).
for vendored_skill_dir in "$VENDORED_SKILLS"/*/; do
  skill_name="$(basename "$vendored_skill_dir")"
  [[ "$skill_name" == "VERSION" ]] && continue
  if [[ ! -d "$SCRATCH_SKILLS/$skill_name" ]]; then
    echo "- REMOVED  $skill_name (vendored; not in binary templates)"
    REMOVED=$((REMOVED+1))
  fi
done

# VERSION file drift
CURRENT_VENDORED_VERSION=""
[[ -f "$VERSION_FILE" ]] && CURRENT_VENDORED_VERSION="$(cat "$VERSION_FILE" | tr -d '[:space:]')"
echo
echo "Vendored VERSION: ${CURRENT_VENDORED_VERSION:-<missing>}"
echo "Binary  VERSION: $BINARY_VERSION"

if [[ $CHANGED -eq 0 && $ADDED -eq 0 && $REMOVED -eq 0 && "$CURRENT_VENDORED_VERSION" == "$BINARY_VERSION" ]]; then
  echo "No drift. Nothing to sync."
  exit 0
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo
  echo "Dry run. Exiting without changes."
  exit 0
fi

echo
read -r -p "Apply changes to $VENDORED_SKILLS? [y/N] " ANSWER
case "$ANSWER" in
  y|Y|yes|YES) ;;
  *) echo "Declined. Exiting."; exit 2 ;;
esac

# Apply: rsync each scratch skill into vendored tree; do NOT touch any other file.
for scratch_skill_dir in "$SCRATCH_SKILLS"/*/; do
  skill_name="$(basename "$scratch_skill_dir")"
  target_dir="$VENDORED_SKILLS/$skill_name"
  mkdir -p "$target_dir"
  rsync -a --delete "$scratch_skill_dir" "$target_dir/"
done

printf '%s\n' "$BINARY_VERSION" > "$VERSION_FILE"

echo
echo "Sync complete. Review with: git status -- extensions/gitnexus/skills/"
echo "Suggested commit: git commit -m \"chore(gitnexus): sync skills to binary v$BINARY_VERSION\""
