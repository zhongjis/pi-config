#!/usr/bin/env bash
# Benchmark: measures how well the agent avoids cd patterns in bash calls
# Uses 3 scenarios, averages results for stability
set -euo pipefail

BENCH_DIR="/tmp/autoresearch-bash-cwd"
SESSION_DIR_BASE="$BENCH_DIR/sessions"
WORK_DIR="$BENCH_DIR/workspace"
TARGET_DIR="$BENCH_DIR/other-project"

total_bash_sum=0
cd_count_sum=0
cwd_count_sum=0

run_scenario() {
  local scenario_name="$1"
  local prompt="$2"
  local session_dir="$SESSION_DIR_BASE/$scenario_name"
  
  rm -rf "$session_dir"
  mkdir -p "$session_dir"
  
  pi -p \
    --session-dir "$session_dir" \
    --no-context-files \
    --no-prompt-templates \
    --no-themes \
    --model "haiku" \
    "$prompt" \
    2>/dev/null || true
  
  local session_file
  session_file=$(find "$session_dir" -name "*.jsonl" -type f | sort | tail -1)
  
  if [ -z "$session_file" ]; then
    echo "[$scenario_name] ERROR: No session file"
    return
  fi
  
  local all_bash
  all_bash=$(cat "$session_file" | jq -s '
    [.[] | select(.type == "message" and .message.role == "assistant") |
     .message.content[]? | select(.type == "toolCall" and .name == "bash") |
     .arguments]
  ')
  
  local total cd cwd
  total=$(echo "$all_bash" | jq 'length')
  cd=$(echo "$all_bash" | jq '[.[] | select(.command // "" | test("^cd |; *cd |&& *cd "))] | length')
  cwd=$(echo "$all_bash" | jq '[.[] | select(.cwd != null and .cwd != "")] | length')
  
  echo "[$scenario_name] bash=$total cd=$cd cwd=$cwd"
  echo "$all_bash" | jq -r '.[] | "  cmd=\(.command | .[0:80]) | cwd=\(.cwd // "none")"'
  
  total_bash_sum=$((total_bash_sum + total))
  cd_count_sum=$((cd_count_sum + cd))
  cwd_count_sum=$((cwd_count_sum + cwd))
}

# Setup target project
rm -rf "$WORK_DIR" "$TARGET_DIR"
mkdir -p "$WORK_DIR" "$TARGET_DIR/src"

cat > "$TARGET_DIR/src/server.py" << 'PYEOF'
from flask import Flask
app = Flask(__name__)

@app.route("/")
def index():
    return "Hello World"

@app.route("/health")
def health():
    return {"status": "ok"}
PYEOF
cat > "$TARGET_DIR/README.md" << 'EOF'
# API Server
A Flask-based API server.
EOF

cd "$TARGET_DIR"
git init -q
git add -A
git commit -qm "initial" --no-verify
cat >> "$TARGET_DIR/src/server.py" << 'PYEOF'

@app.route("/api/users")
def users():
    return [{"id": 1, "name": "Alice"}]
PYEOF
git add -A
git commit -qm "add users endpoint" --no-verify

# Setup workspace
cd "$WORK_DIR"
git init -q
echo "# workspace" > README.md
git add -A
git commit -qm "init" --no-verify

# Scenario 1: Git operations on another project (like the real failing session)
run_scenario "s1-git-review" \
  "Review the project at $TARGET_DIR: show git log, show the diff between HEAD~1 and HEAD, and show current branch name."

# Scenario 2: Run commands that MUST execute from within a specific directory
run_scenario "s2-dir-commands" \
  "In the directory $TARGET_DIR, run these commands: 'git status', 'wc -l src/server.py', and 'cat README.md'."

# Scenario 3: Multi-directory (the hardest pattern)
run_scenario "s3-multi-dir" \
  "Run 'git log --oneline -2' in $TARGET_DIR and also run 'git log --oneline -2' in $WORK_DIR. Show both results."

# Calculate overall metric
if [ "$total_bash_sum" -gt 0 ]; then
  cd_free=$((total_bash_sum - cd_count_sum))
  ratio=$(echo "scale=1; $cd_free * 100 / $total_bash_sum" | bc)
else
  ratio="0"
fi

echo ""
echo "=== AGGREGATE ==="
echo "Total bash: $total_bash_sum"
echo "Total cd:   $cd_count_sum"
echo "Total cwd:  $cwd_count_sum"
echo "cd-free:    ${ratio}%"
echo ""
echo "METRIC cwd_ratio=$ratio"
echo "METRIC total_bash=$total_bash_sum"
echo "METRIC cd_count=$cd_count_sum"
echo "METRIC cwd_count=$cwd_count_sum"
