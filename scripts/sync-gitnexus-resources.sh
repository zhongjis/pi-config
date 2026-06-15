#!/usr/bin/env bash
# scripts/sync-gitnexus-resources.sh
# Manual sync of vendored GitNexus skills against the installed binary package.
# Reads packaged skills from the installed gitnexus package; diffs them against the vendored tree;
# prompts before applying. Never runs gitnexus analyze in the repo working tree.

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

Sync vendored GitNexus skill templates against the installed gitnexus binary package.
Reads the package's skills/*.md files; prompts before applying diffs into
extensions/gitnexus/skills/. Never runs analyze or touches the repo working tree
without confirmation.

Options:
  --dry-run   Show diffs without applying or prompting.
  -h, --help  Show this help.

Exit codes:
  0  success or no-op
  2  user declined apply
  3  other error
EOF
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 3 ;;
  esac
done

command -v gitnexus >/dev/null || { echo "gitnexus not on PATH" >&2; exit 3; }
command -v node >/dev/null || { echo "node not on PATH" >&2; exit 3; }

BINARY_VERSION="$(gitnexus --version | head -1 | tr -d '[:space:]')"
echo "Installed binary: gitnexus $BINARY_VERSION"

GITNEXUS_BIN="$(command -v gitnexus)"
GITNEXUS_REAL="$(readlink -f "$GITNEXUS_BIN" 2>/dev/null || printf '%s\n' "$GITNEXUS_BIN")"

PACKAGE_SKILLS=""
declare -a SKILL_ROOT_CANDIDATES=(
  "$(dirname "$GITNEXUS_REAL")/../lib/node_modules/gitnexus/skills"
  "$(dirname "$GITNEXUS_REAL")/../../skills"
  "$(dirname "$GITNEXUS_REAL")/../skills"
)

for candidate in "${SKILL_ROOT_CANDIDATES[@]}"; do
  if [[ -d "$candidate" ]]; then
    PACKAGE_SKILLS="$(realpath "$candidate")"
    break
  fi
done

if [[ -z "$PACKAGE_SKILLS" ]]; then
  echo "Could not locate packaged GitNexus skills for $GITNEXUS_REAL" >&2
  exit 3
fi

echo "Packaged skills: $PACKAGE_SKILLS"

SCRATCH="$(mktemp -d -t gitnexus-skills.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

adapt_skill_for_local_tools() {
  local source="$1"
  local target="$2"
  node - "$source" "$target" <<'NODE'
const fs = require('node:fs');
const [source, target] = process.argv.slice(2);
let text = fs.readFileSync(source, 'utf8');
text = text.replace(/node \.gitnexus\/run\.cjs analyze/g, '/gitnexus analyze');
text = text.replace(/run `\/gitnexus analyze` in terminal/g, 'run `/gitnexus analyze` in pi');
text = text.replace(/run `\/gitnexus analyze` in the terminal/g, 'run `/gitnexus analyze` in pi');
const replacements = new Map([
  ['query', 'gitnexus_query'],
  ['context', 'gitnexus_context'],
  ['impact', 'gitnexus_impact'],
  ['detect_changes', 'gitnexus_detect_changes'],
  ['rename', 'gitnexus_rename'],
  ['cypher', 'gitnexus_cypher'],
]);
for (const [from, to] of replacements) {
  text = text
    .replace(new RegExp(`\\b${from}\\(`, 'g'), `${to}(`)
    .replace(new RegExp(`\\*\\*${from}\\*\\*`, 'g'), `**${to}**`)
    .replace(new RegExp('`' + from + '`', 'g'), `\`${to}\``)
    .replace(new RegExp(`- \\[ \\] ${from}\\b`, 'g'), `- [ ] ${to}`);
}
fs.mkdirSync(require('node:path').dirname(target), { recursive: true });
fs.writeFileSync(target, text);
NODE
}

for package_skill in "$PACKAGE_SKILLS"/*.md; do
  skill_name="$(basename "$package_skill" .md)"
  adapt_skill_for_local_tools "$package_skill" "$SCRATCH/$skill_name/SKILL.md"
done

echo
echo "=== Skill diff summary ==="
CHANGED=0
ADDED=0
REMOVED=0

for scratch_skill_dir in "$SCRATCH"/*/; do
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

for vendored_skill_dir in "$VENDORED_SKILLS"/gitnexus-*/; do
  skill_name="$(basename "$vendored_skill_dir")"
  if [[ ! -d "$SCRATCH/$skill_name" ]]; then
    echo "- REMOVED  $skill_name (vendored; not in binary package skills)"
    REMOVED=$((REMOVED+1))
  fi
done

CURRENT_VENDORED_VERSION=""
[[ -f "$VERSION_FILE" ]] && CURRENT_VENDORED_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
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

for scratch_skill_dir in "$SCRATCH"/*/; do
  skill_name="$(basename "$scratch_skill_dir")"
  target_dir="$VENDORED_SKILLS/$skill_name"
  mkdir -p "$target_dir"
  cp "$scratch_skill_dir/SKILL.md" "$target_dir/SKILL.md"
done

printf '%s\n' "$BINARY_VERSION" > "$VERSION_FILE"

echo
echo "Sync complete. Review with: git status -- extensions/gitnexus/skills/"
echo "Suggested commit: git commit -m \"chore(gitnexus): sync skills to binary v$BINARY_VERSION\""
