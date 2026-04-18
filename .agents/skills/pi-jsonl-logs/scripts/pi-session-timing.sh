#!/usr/bin/env bash
# pi-session-timing.sh — Measure time between events in a session
# Usage: pi-session-timing.sh <session.jsonl> --from PATTERN --to PATTERN
#
# Match modes (use one per endpoint):
#   --from/--to PATTERN       Match text content (user/assistant messages)
#   --from-tool/--to-tool NAME  Match by tool name
#   --from-tool-arg/--to-tool-arg 'NAME:PATTERN'  Match tool call where arg JSON contains PATTERN
#
# Examples:
#   pi-session-timing.sh s.jsonl --from-tool-arg 'Agent:fuxi' --to 'skip fuxi'
#   pi-session-timing.sh s.jsonl --from 'plannotator never' --to 'skip fuxi'
#   pi-session-timing.sh s.jsonl --from-tool Agent --to-tool get_subagent_result

set -euo pipefail

SESSION=""
FROM_PAT=""
TO_PAT=""
FROM_TOOL=""
TO_TOOL=""
FROM_TOOL_ARG=""
TO_TOOL_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM_PAT="$2"; shift 2 ;;
    --to) TO_PAT="$2"; shift 2 ;;
    --from-tool) FROM_TOOL="$2"; shift 2 ;;
    --to-tool) TO_TOOL="$2"; shift 2 ;;
    --from-tool-arg) FROM_TOOL_ARG="$2"; shift 2 ;;
    --to-tool-arg) TO_TOOL_ARG="$2"; shift 2 ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) SESSION="$1"; shift ;;
  esac
done

: "${SESSION:?Usage: pi-session-timing.sh <session.jsonl> --from PATTERN --to PATTERN}"

if [[ ! -f "$SESSION" ]]; then
  echo "Error: file not found: $SESSION" >&2
  exit 1
fi

if [[ -z "$FROM_PAT" && -z "$FROM_TOOL" && -z "$FROM_TOOL_ARG" ]] || [[ -z "$TO_PAT" && -z "$TO_TOOL" && -z "$TO_TOOL_ARG" ]]; then
  echo "Error: need both --from/--from-tool/--from-tool-arg and --to/--to-tool/--to-tool-arg" >&2
  exit 1
fi

# Helper: build jq matcher for an endpoint
build_matcher() {
  local pat="$1" tool="$2" tool_arg="$3"
  if [[ -n "$tool_arg" ]]; then
    local tname="${tool_arg%%:*}"
    local tpat="${tool_arg#*:}"
    echo "select(.type==\"message\" and .message.role==\"assistant\") | select(.message.content | type==\"array\" and any(.[]; .type==\"toolCall\" and (.name | test(\"${tname}\"; \"i\")) and ((.arguments | if type==\"string\" then . else tostring end) | test(\"${tpat}\"; \"i\"))))"
  elif [[ -n "$tool" ]]; then
    echo "select(.type==\"message\" and .message.role==\"assistant\") | select(.message.content | type==\"array\" and any(.[]; .type==\"toolCall\" and (.name | test(\"${tool}\"; \"i\"))))"
  else
    echo "select(.type==\"message\") | select((.message.content | if type==\"string\" then . else [.[] | select(.type==\"text\") | .text] | join(\"\") end) | test(\"${pat}\"; \"i\"))"
  fi
}

FROM_JQ=$(build_matcher "$FROM_PAT" "$FROM_TOOL" "$FROM_TOOL_ARG")
TO_JQ=$(build_matcher "$TO_PAT" "$TO_TOOL" "$TO_TOOL_ARG")

# Get first matching timestamps
FROM_TS=$(jq -r "${FROM_JQ} | .timestamp" "$SESSION" 2>/dev/null | head -1)
TO_TS=$(jq -r "${TO_JQ} | .timestamp" "$SESSION" 2>/dev/null | head -1)

if [[ -z "$FROM_TS" || "$FROM_TS" == "null" ]]; then
  echo "Error: no 'from' event matched" >&2
  exit 1
fi
if [[ -z "$TO_TS" || "$TO_TS" == "null" ]]; then
  echo "Error: no 'to' event matched" >&2
  exit 1
fi

# If --to comes before --from, find the FIRST --to AFTER --from
# Get to-event that's after from-event
TO_TS=$(jq -r "${TO_JQ} | .timestamp" "$SESSION" 2>/dev/null | while read ts; do
  if [[ "$ts" > "$FROM_TS" || "$ts" == "$FROM_TS" ]]; then
    echo "$ts"
    break
  fi
done)

if [[ -z "$TO_TS" ]]; then
  echo "Error: no 'to' event found after 'from' event" >&2
  exit 1
fi

echo "from: $FROM_TS"
echo "to:   $TO_TS"

# Calculate duration
python3 -c "
from datetime import datetime
fmt = '%Y-%m-%dT%H:%M:%S'
t1 = datetime.strptime('${FROM_TS}'.split('.')[0], fmt)
t2 = datetime.strptime('${TO_TS}'.split('.')[0], fmt)
d = t2 - t1
mins = int(d.total_seconds()) // 60
secs = int(d.total_seconds()) % 60
print(f'duration: {mins}m {secs}s ({int(d.total_seconds())}s)')
"
