#!/usr/bin/env bash
# pi-session-overview.sh — One-shot session summary
# Usage: pi-session-overview.sh <session.jsonl>
#
# Outputs: entry type breakdown, message roles, tool frequency,
#          total cost, total tokens, model used, session duration.

set -euo pipefail

SESSION="${1:?Usage: pi-session-overview.sh <session.jsonl>}"

if [[ ! -f "$SESSION" ]]; then
  echo "Error: file not found: $SESSION" >&2
  exit 1
fi

echo "=== Session: $(basename "$SESSION") ==="
echo ""

# Session header
echo "--- Metadata ---"
jq -r 'select(.type=="session") | "  cwd:     \(.cwd // "unknown")\n  version: \(.version // "?")\n  started: \(.timestamp // "?")"' "$SESSION"

# Session name (if set)
NAME=$(jq -r 'select(.type=="session_info") | .name' "$SESSION" 2>/dev/null | tail -1)
[[ -n "$NAME" && "$NAME" != "null" ]] && echo "  name:    $NAME"
echo ""

# Entry type breakdown
echo "--- Entry Types ---"
jq -r '.type' "$SESSION" | sort | uniq -c | sort -rn | sed 's/^/  /'
echo ""

# Message role breakdown
echo "--- Message Roles ---"
jq -r 'select(.type=="message") | .message.role' "$SESSION" | sort | uniq -c | sort -rn | sed 's/^/  /'
echo ""

# Tool call frequency
echo "--- Tool Usage ---"
TOOLS=$(jq -r 'select(.type=="message" and .message.role=="assistant") |
  .message.content[] | select(.type=="toolCall") | .name' "$SESSION" |
  sort | uniq -c | sort -rn)
if [[ -n "$TOOLS" ]]; then
  echo "$TOOLS" | sed 's/^/  /'
else
  echo "  (no tool calls)"
fi
echo ""

# Cost and tokens
echo "--- Cost & Tokens ---"
jq -rs '
  [.[] | select(.type=="message" and .message.role=="assistant") | .message.usage] |
  {
    total_cost: (map(.cost.total // 0) | add),
    total_tokens: (map(.totalTokens // 0) | add),
    input_tokens: (map(.input // 0) | add),
    output_tokens: (map(.output // 0) | add),
    cache_read: (map(.cacheRead // 0) | add),
    cache_write: (map(.cacheWrite // 0) | add),
    turns: length
  } |
  "  cost:        $\(.total_cost)\n  tokens:      \(.total_tokens)\n  input:       \(.input_tokens)\n  output:      \(.output_tokens)\n  cache_read:  \(.cache_read)\n  cache_write: \(.cache_write)\n  turns:       \(.turns)"
' "$SESSION"
echo ""

# Model
echo "--- Model ---"
jq -r 'select(.type=="message" and .message.role=="assistant") | .message.model // empty' "$SESSION" | sort | uniq -c | sort -rn | sed 's/^/  /'
echo ""

# Duration (first timestamp → last timestamp)
echo "--- Duration ---"
jq -rs '
  [.[] | .timestamp // empty | select(. != null)] |
  if length > 1 then
    (first | split(".")[0] | strptime("%Y-%m-%dT%H:%M:%S") | mktime) as $start |
    (last  | split(".")[0] | strptime("%Y-%m-%dT%H:%M:%S") | mktime) as $end |
    ($end - $start) |
    "  \(. / 60 | floor)m \(. % 60)s (from \($start | strftime("%H:%M:%S")) to \($end | strftime("%H:%M:%S")))"
  else "  (single entry)" end
' "$SESSION"
