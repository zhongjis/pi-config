#!/usr/bin/env bash
# pi-session-thread.sh — Conversation thread with timestamps
# Usage: pi-session-thread.sh <session.jsonl> [--max-chars N] [--head N] [--tail N] [--tools]
#
# Options:
#   --max-chars N   Truncate each message to N chars (default: 300)
#   --head N        Show first N messages only
#   --tail N        Show last N messages only
#   --tools         Include tool calls and results (default: user+assistant text only)

set -euo pipefail

SESSION=""
MAX_CHARS=300
HEAD=""
TAIL=""
SHOW_TOOLS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-chars) MAX_CHARS="$2"; shift 2 ;;
    --head) HEAD="$2"; shift 2 ;;
    --tail) TAIL="$2"; shift 2 ;;
    --tools) SHOW_TOOLS=true; shift ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) SESSION="$1"; shift ;;
  esac
done

: "${SESSION:?Usage: pi-session-thread.sh <session.jsonl> [--max-chars N] [--head N] [--tail N] [--tools]}"

if [[ ! -f "$SESSION" ]]; then
  echo "Error: file not found: $SESSION" >&2
  exit 1
fi

# Build role filter
if [[ "$SHOW_TOOLS" == "true" ]]; then
  ROLE_FILTER='select(.type=="message")'
else
  ROLE_FILTER='select(.type=="message" and (.message.role=="user" or .message.role=="assistant"))'
fi

OUTPUT=$(jq -r "
  ${ROLE_FILTER} |
  if .message.role==\"user\" then
    \"\(.timestamp) | USER | \" +
    (.message.content |
      if type==\"string\" then .[:${MAX_CHARS}]
      else (map(select(.type==\"text\") | .text) | join(\"\"))[:${MAX_CHARS}]
      end)
  elif .message.role==\"assistant\" then
    \"\(.timestamp) | ASST | \" +
    ([.message.content[] |
      if .type==\"text\" then .text
      elif .type==\"toolCall\" then \"[TOOL:\(.name)]\"
      else empty end
    ] | join(\" \"))[:${MAX_CHARS}]
  elif .message.role==\"toolResult\" then
    \"\(.timestamp) | RESULT:\(.message.toolName) err=\(.message.isError) | \" +
    ([.message.content[] | select(.type==\"text\") | .text] | join(\"\"))[:${MAX_CHARS}]
  else empty end
" "$SESSION" 2>/dev/null)

# Apply head/tail
if [[ -n "$HEAD" ]]; then
  echo "$OUTPUT" | head -"$HEAD"
elif [[ -n "$TAIL" ]]; then
  echo "$OUTPUT" | tail -"$TAIL"
else
  echo "$OUTPUT"
fi
