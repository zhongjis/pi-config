#!/usr/bin/env bash
# Benchmark: measures how well the agent avoids cd patterns in bash calls
# Simulates real-world: user asks agent to work on a project at a different path
set -euo pipefail

BENCH_DIR="/tmp/autoresearch-bash-cwd"
SESSION_DIR="$BENCH_DIR/sessions"
WORK_DIR="$BENCH_DIR/workspace"
TARGET_DIR="$BENCH_DIR/other-project"

rm -rf "$SESSION_DIR" "$WORK_DIR" "$TARGET_DIR"
mkdir -p "$SESSION_DIR" "$WORK_DIR" "$TARGET_DIR"

# Create target project (the one we want to inspect)
cat > "$TARGET_DIR/main.py" << 'PYEOF'
def greet(name):
    return f"Hello, {name}!"

if __name__ == "__main__":
    print(greet("world"))
PYEOF
cat > "$TARGET_DIR/README.md" << 'EOF'
# Other Project
A simple Python greeting app.
EOF

cd "$TARGET_DIR"
git init -q
git add -A
git commit -qm "initial commit" --no-verify
echo "# changelog" > CHANGELOG.md
git add -A
git commit -qm "add changelog" --no-verify

# Create workspace (pi's cwd)
cd "$WORK_DIR"
git init -q
echo "# my workspace" > README.md
git add -A
git commit -qm "init" --no-verify

# Key test: user references an ABSOLUTE path to another project
# This is the pattern from the real session — agent needs to run commands
# in /some/other/path
PROMPT="I need you to inspect the project at $TARGET_DIR. Please:
1. Show the git log (last 3 commits)
2. Show the contents of main.py
3. List all files
Run all commands targeting that directory."

pi -p \
  --session-dir "$SESSION_DIR" \
  --no-context-files \
  --no-prompt-templates \
  --no-themes \
  --model "haiku" \
  "$PROMPT" \
  2>/dev/null || true

SESSION_FILE=$(find "$SESSION_DIR" -name "*.jsonl" -type f | sort | tail -1)

if [ -z "$SESSION_FILE" ]; then
  echo "ERROR: No session file found"
  echo "METRIC cwd_ratio=0"
  exit 0
fi

ALL_BASH=$(cat "$SESSION_FILE" | jq -s '
  [.[] | select(.type == "message" and .message.role == "assistant") |
   .message.content[]? | select(.type == "toolCall" and .name == "bash") |
   .arguments]
')

TOTAL_BASH=$(echo "$ALL_BASH" | jq 'length')
CD_COUNT=$(echo "$ALL_BASH" | jq '[.[] | select(.command // "" | test("^cd |; *cd |&& *cd "))] | length')
CWD_COUNT=$(echo "$ALL_BASH" | jq '[.[] | select(.cwd != null and .cwd != "")] | length')

if [ "$TOTAL_BASH" -gt 0 ]; then
  CD_FREE=$((TOTAL_BASH - CD_COUNT))
  RATIO=$(echo "scale=1; $CD_FREE * 100 / $TOTAL_BASH" | bc)
else
  RATIO="0"
fi

echo "--- Results ---"
echo "Total bash calls: $TOTAL_BASH"
echo "cd pattern calls: $CD_COUNT"
echo "cwd param calls:  $CWD_COUNT"
echo "cd-free ratio:    ${RATIO}%"
echo ""
echo "METRIC cwd_ratio=$RATIO"
echo "METRIC total_bash=$TOTAL_BASH"
echo "METRIC cd_count=$CD_COUNT"
echo "METRIC cwd_count=$CWD_COUNT"

echo ""
echo "--- All bash commands ---"
echo "$ALL_BASH" | jq -r '.[] | "cmd=\(.command) | cwd=\(.cwd // "none")"'
