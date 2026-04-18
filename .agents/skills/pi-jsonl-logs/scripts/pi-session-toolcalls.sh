#!/usr/bin/env bash
# pi-session-toolcalls.sh — Extract and filter tool calls
# Usage: pi-session-toolcalls.sh <session.jsonl> [--tool NAME] [--field FIELD] [--compact]
#
# Options:
#   --tool NAME    Filter by tool name (regex, case-insensitive)
#   --field FIELD  Extract specific argument field (e.g., "command", "path", "prompt")
#   --compact      One line per call (default: multi-line)
#   --with-results Include tool results after each call
#
# Handles both string and object .arguments automatically.
#
# Examples:
#   pi-session-toolcalls.sh s.jsonl --tool bash --field command
#   pi-session-toolcalls.sh s.jsonl --tool "read|write|edit" --field path
#   pi-session-toolcalls.sh s.jsonl --tool Agent --field subagent_type --compact

set -euo pipefail

SESSION=""
TOOL_FILTER=""
FIELD=""
COMPACT=false
WITH_RESULTS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tool) TOOL_FILTER="$2"; shift 2 ;;
    --field) FIELD="$2"; shift 2 ;;
    --compact) COMPACT=true; shift ;;
    --with-results) WITH_RESULTS=true; shift ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) SESSION="$1"; shift ;;
  esac
done

: "${SESSION:?Usage: pi-session-toolcalls.sh <session.jsonl> [--tool NAME] [--field FIELD] [--compact]}"

if [[ ! -f "$SESSION" ]]; then
  echo "Error: file not found: $SESSION" >&2
  exit 1
fi

# Build tool name filter
if [[ -n "$TOOL_FILTER" ]]; then
  NAME_FILTER="| select(.name | test(\"${TOOL_FILTER}\"; \"i\"))"
else
  NAME_FILTER=""
fi

# Build output format
if [[ -n "$FIELD" ]]; then
  if [[ "$COMPACT" == "true" ]]; then
    OUTPUT="(.arguments | if type==\"string\" then fromjson else . end | .${FIELD} // \"null\") | tostring"
  else
    OUTPUT='"[\($ts)] \(.name) \(.id // \"\")  \(.field_name)=\(.field_val)"'
    # Need a different approach for named field display
    jq -r "
      select(.type==\"message\" and .message.role==\"assistant\") |
      .timestamp as \$ts |
      .message.content[] |
      select(.type==\"toolCall\") ${NAME_FILTER} |
      (.arguments | if type==\"string\" then fromjson else . end | .${FIELD} // \"null\" | tostring) as \$val |
      \"[\(\$ts)] \(.name) | ${FIELD}=\(\$val)\"
    " "$SESSION" 2>/dev/null
    exit 0
  fi
elif [[ "$COMPACT" == "true" ]]; then
  OUTPUT='"\($ts) \(.name) \(.arguments | if type=="string" then (fromjson | keys | join(",")) else (keys | join(",")) end)"'
else
  OUTPUT='"\($ts) \(.name)\n  args: \(.arguments | if type=="string" then . else tostring end)"'
fi

# Main extraction (compact field mode)
if [[ -n "$FIELD" && "$COMPACT" == "true" ]]; then
  jq -r "
    select(.type==\"message\" and .message.role==\"assistant\") |
    .message.content[] |
    select(.type==\"toolCall\") ${NAME_FILTER} |
    (.arguments | if type==\"string\" then fromjson else . end | .${FIELD} // \"null\") | tostring
  " "$SESSION" 2>/dev/null
else
  jq -r "
    select(.type==\"message\" and .message.role==\"assistant\") |
    .timestamp as \$ts |
    .message.content[] |
    select(.type==\"toolCall\") ${NAME_FILTER} |
    ${OUTPUT}
  " "$SESSION" 2>/dev/null
fi

# Tool results (if requested)
if [[ "$WITH_RESULTS" == "true" && -n "$TOOL_FILTER" ]]; then
  echo ""
  echo "--- Results for matched tools ---"
  jq -r "
    select(.type==\"message\" and .message.role==\"toolResult\") |
    select(.message.toolName | test(\"${TOOL_FILTER}\"; \"i\")) |
    \"\(.timestamp) | \(.message.toolName) err=\(.message.isError) | \" +
    ([.message.content[] | select(.type==\"text\") | .text] | join(\"\"))[:300]
  " "$SESSION" 2>/dev/null
fi
