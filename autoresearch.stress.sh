#!/usr/bin/env bash
# Stress test: mirrors the original failing session pattern
# Agent must do code review on a project at a different path
set -euo pipefail

BENCH_DIR="/tmp/autoresearch-bash-cwd"
SESSION_DIR="$BENCH_DIR/sessions/stress"
TARGET_DIR="$BENCH_DIR/review-project"
WORK_DIR="$BENCH_DIR/workspace"

MODEL="${BENCH_MODEL:-haiku}"

rm -rf "$SESSION_DIR" "$WORK_DIR" "$TARGET_DIR"
mkdir -p "$SESSION_DIR" "$WORK_DIR" "$TARGET_DIR/src" "$TARGET_DIR/tests"

# Create a project with multi-commit history to review
cat > "$TARGET_DIR/src/auth.py" << 'PYEOF'
class AuthService:
    def __init__(self, secret_key):
        self.secret_key = secret_key

    def authenticate(self, token):
        return token == self.secret_key
PYEOF
cat > "$TARGET_DIR/src/api.py" << 'PYEOF'
from flask import Flask, request
app = Flask(__name__)

@app.route("/api/v1/users")
def list_users():
    return [{"id": 1}]
PYEOF
cat > "$TARGET_DIR/tests/test_auth.py" << 'PYEOF'
from src.auth import AuthService

def test_auth():
    svc = AuthService("secret")
    assert svc.authenticate("secret")
    assert not svc.authenticate("wrong")
PYEOF

cd "$TARGET_DIR"
git init -q
git checkout -b main -q
git add -A
git commit -qm "initial: auth + api + tests" --no-verify

# Add a feature branch
git checkout -b feat/rate-limit -q
cat >> "$TARGET_DIR/src/api.py" << 'PYEOF'

@app.route("/api/v1/users/<int:uid>")
def get_user(uid):
    return {"id": uid, "name": "User"}
PYEOF
cat > "$TARGET_DIR/src/rate_limit.py" << 'PYEOF'
import time

class RateLimiter:
    def __init__(self, max_calls, period):
        self.max_calls = max_calls
        self.period = period
        self.calls = []

    def allow(self):
        now = time.time()
        self.calls = [t for t in self.calls if now - t < self.period]
        if len(self.calls) < self.max_calls:
            self.calls.append(now)
            return True
        return False
PYEOF
git add -A
git commit -qm "feat: add rate limiter + get_user endpoint" --no-verify

cat > "$TARGET_DIR/tests/test_rate_limit.py" << 'PYEOF'
from src.rate_limit import RateLimiter

def test_rate_limiter():
    rl = RateLimiter(2, 1.0)
    assert rl.allow()
    assert rl.allow()
    assert not rl.allow()
PYEOF
git add -A
git commit -qm "test: add rate limiter tests" --no-verify

# Workspace (pi's cwd)
cd "$WORK_DIR"
git init -q
echo "workspace" > README.md
git add -A
git commit -qm "init" --no-verify

# The realistic prompt: mirroring the original session where the user
# asked for a PR review on a project at a different path
PROMPT="Please review the feature branch at $TARGET_DIR. The branch is feat/rate-limit and main is the base. I need:
1. List the commits on feat/rate-limit that aren't on main
2. Show the overall diff stats
3. Show the diff of each changed file
4. Show the current branch name"

pi -p \
  --session-dir "$SESSION_DIR" \
  --no-context-files \
  --no-prompt-templates \
  --no-themes \
  --model "$MODEL" \
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

echo ""
echo "=== STRESS TEST (model=$MODEL) ==="
echo "Total bash: $TOTAL_BASH"
echo "cd pattern: $CD_COUNT"
echo "cwd param:  $CWD_COUNT"
echo "cd-free:    ${RATIO}%"
echo ""
echo "METRIC cwd_ratio=$RATIO"
echo "METRIC total_bash=$TOTAL_BASH"
echo "METRIC cd_count=$CD_COUNT"
echo "METRIC cwd_count=$CWD_COUNT"

echo ""
echo "--- All bash commands ---"
echo "$ALL_BASH" | jq -r '.[] | "  cmd=\(.command | .[0:100]) | cwd=\(.cwd // "none")"'
