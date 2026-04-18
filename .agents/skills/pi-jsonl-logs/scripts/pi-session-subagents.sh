#!/usr/bin/env bash
# pi-session-subagents.sh — Extract Agent/subagent delegations
# Usage: pi-session-subagents.sh <session.jsonl> [--type TYPE] [--prompt-len N]
#
# Options:
#   --type TYPE      Filter by subagent_type (e.g., fuxi, chengfeng, jintong)
#   --prompt-len N   Max chars of prompt to show (default: 200, 0=hide, -1=full)
#
# Handles both string and object .arguments (the common gotcha).

set -euo pipefail

SESSION=""
FILTER_TYPE=""
PROMPT_LEN=200

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type) FILTER_TYPE="$2"; shift 2 ;;
    --prompt-len) PROMPT_LEN="$2"; shift 2 ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) SESSION="$1"; shift ;;
  esac
done

: "${SESSION:?Usage: pi-session-subagents.sh <session.jsonl> [--type TYPE] [--prompt-len N]}"

if [[ ! -f "$SESSION" ]]; then
  echo "Error: file not found: $SESSION" >&2
  exit 1
fi

# Build jq filter for type
TYPE_FILTER=""
if [[ -n "$FILTER_TYPE" ]]; then
  TYPE_FILTER="| select(.subagent_type == \"$FILTER_TYPE\")"
fi

# Build prompt display logic
if [[ "$PROMPT_LEN" == "0" ]]; then
  PROMPT_EXPR='""'
elif [[ "$PROMPT_LEN" == "-1" ]]; then
  PROMPT_EXPR='.prompt // ""'
else
  PROMPT_EXPR="(.prompt // \"\")[:${PROMPT_LEN}]"
fi

jq -r "
  select(.type==\"message\" and .message.role==\"assistant\") |
  .timestamp as \$ts |
  .message.content[] |
  select(.type==\"toolCall\" and .name==\"Agent\") |
  (.arguments | if type==\"string\" then fromjson else . end) ${TYPE_FILTER} |
  {
    ts: \$ts,
    type: (.subagent_type // \"unknown\"),
    desc: (.description // \"no desc\"),
    bg: (.run_in_background // false),
    turns: (.max_turns // \"unset\"),
    model: (.model // \"default\"),
    prompt_preview: ${PROMPT_EXPR}
  } |
  \"[\(.ts)] \(.type) | \(.desc) | bg=\(.bg) turns=\(.turns) model=\(.model)\" +
  if .prompt_preview != \"\" then \"\n  prompt: \(.prompt_preview)\" else \"\" end
" "$SESSION" 2>/dev/null

# Summary
echo ""
echo "--- Summary ---"
jq -r '
  select(.type=="message" and .message.role=="assistant") |
  .message.content[] |
  select(.type=="toolCall" and .name=="Agent") |
  (.arguments | if type=="string" then fromjson else . end) |
  .subagent_type // "unknown"
' "$SESSION" 2>/dev/null | sort | uniq -c | sort -rn | sed 's/^/  /'
