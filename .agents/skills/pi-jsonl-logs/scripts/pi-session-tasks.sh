#!/usr/bin/env bash
# pi-session-tasks.sh — Task lifecycle extraction
# Usage: pi-session-tasks.sh <session.jsonl>
#
# Shows TaskCreate, TaskUpdate, and TaskExecute calls.
# Tracks: task subjects, status transitions, completion order.

set -euo pipefail

SESSION="${1:?Usage: pi-session-tasks.sh <session.jsonl>}"

if [[ ! -f "$SESSION" ]]; then
  echo "Error: file not found: $SESSION" >&2
  exit 1
fi

echo "=== Task Creates ==="
jq -r '
  select(.type=="message" and .message.role=="assistant") |
  .timestamp as $ts |
  .message.content[] |
  select(.type=="toolCall" and .name=="TaskCreate") |
  (.arguments | if type=="string" then fromjson else . end) |
  "[\($ts)] \(.subject // "no subject")" +
  if .agentType then " [agent: \(.agentType)]" else "" end +
  if .description then "\n  desc: \(.description[:150])" else "" end
' "$SESSION" 2>/dev/null

echo ""
echo "=== Task Updates ==="
jq -r '
  select(.type=="message" and .message.role=="assistant") |
  .timestamp as $ts |
  .message.content[] |
  select(.type=="toolCall" and .name=="TaskUpdate") |
  (.arguments | if type=="string" then fromjson else . end) |
  "[\($ts)] task#\(.taskId) \u2192 \(.status // "no status")" +
  if .subject then " (\(.subject))" else "" end +
  if .addBlockedBy then " blockedBy=[\(.addBlockedBy | join(","))]" else "" end +
  if .addBlocks then " blocks=[\(.addBlocks | join(","))]" else "" end
' "$SESSION" 2>/dev/null

# Check for TaskExecute
EXEC_COUNT=$(jq -r '
  select(.type=="message" and .message.role=="assistant") |
  .message.content[] |
  select(.type=="toolCall" and .name=="TaskExecute") | .id
' "$SESSION" 2>/dev/null | wc -l | tr -d ' ')

if [[ "$EXEC_COUNT" -gt 0 ]]; then
  echo ""
  echo "=== Task Executions ==="
  jq -r '
    select(.type=="message" and .message.role=="assistant") |
    .timestamp as $ts |
    .message.content[] |
    select(.type=="toolCall" and .name=="TaskExecute") |
    (.arguments | if type=="string" then fromjson else . end) |
    "[\($ts)] execute: \(.task_ids | join(", "))"
  ' "$SESSION" 2>/dev/null
fi

echo ""
echo "--- Summary ---"
CREATE_COUNT=$(jq -r 'select(.type=="message" and .message.role=="assistant") | .message.content[] | select(.type=="toolCall" and .name=="TaskCreate") | .id' "$SESSION" 2>/dev/null | wc -l | tr -d ' ')
UPDATE_COUNT=$(jq -r 'select(.type=="message" and .message.role=="assistant") | .message.content[] | select(.type=="toolCall" and .name=="TaskUpdate") | .id' "$SESSION" 2>/dev/null | wc -l | tr -d ' ')
echo "  creates:    $CREATE_COUNT"
echo "  updates:    $UPDATE_COUNT"
echo "  executions: $EXEC_COUNT"
