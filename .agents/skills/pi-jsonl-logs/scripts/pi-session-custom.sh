#!/usr/bin/env bash
# pi-session-custom.sh — Extract custom and custom_message entries
# Usage: pi-session-custom.sh <session.jsonl> [--type TYPE] [--data] [--compact]
#
# Shows custom/custom_message entries grouped by customType.
#
# Options:
#   --type TYPE   Filter by customType (regex, case-insensitive)
#   --data        Show .data fields (custom) or .content (custom_message)
#   --compact     One line per entry

set -euo pipefail

SESSION=""
TYPE_FILTER=""
SHOW_DATA=false
COMPACT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type) TYPE_FILTER="$2"; shift 2 ;;
    --data) SHOW_DATA=true; shift ;;
    --compact) COMPACT=true; shift ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) SESSION="$1"; shift ;;
  esac
done

: "${SESSION:?Usage: pi-session-custom.sh <session.jsonl> [--type TYPE] [--data] [--compact]}"

if [[ ! -f "$SESSION" ]]; then
  echo "Error: file not found: $SESSION" >&2
  exit 1
fi

# Build type filter
if [[ -n "$TYPE_FILTER" ]]; then
  TFILTER="| select(.customType | test(\"${TYPE_FILTER}\"; \"i\"))"
else
  TFILTER=""
fi

echo "=== Custom Entries ==="

if [[ "$COMPACT" == "true" ]]; then
  jq -r "
    select(.type==\"custom\" or .type==\"custom_message\") ${TFILTER} |
    \"\(.timestamp) | \(.type) | \(.customType // \"unknown\") | \" +
    (if .type==\"custom\" then (.data | keys | join(\",\"))
     else ((.content // \"\") | gsub(\"\\n\"; \" \"))[:150]
     end)
  " "$SESSION" 2>/dev/null
elif [[ "$SHOW_DATA" == "true" ]]; then
  jq -r "
    select(.type==\"custom\" or .type==\"custom_message\") ${TFILTER} |
    \"[\(.timestamp)] \(.type): \(.customType // \"unknown\")\" +
    (if .type==\"custom\" then \"\n  data: \(.data | tostring)\"
     else \"\n  content: \((.content // \"\")[:300])\"
     end) +
    \"\n---\"
  " "$SESSION" 2>/dev/null
else
  jq -r "
    select(.type==\"custom\" or .type==\"custom_message\") ${TFILTER} |
    \"[\(.timestamp)] \(.type): \(.customType // \"unknown\")\" +
    (if .type==\"custom\" then \" | keys: \(.data | keys | join(\",\"))\"
     elif .display == true then \" | display\"
     else \" | hidden\"
     end)
  " "$SESSION" 2>/dev/null
fi

# Summary
echo ""
echo "--- Summary ---"
jq -r "
  select(.type==\"custom\" or .type==\"custom_message\") ${TFILTER} |
  .customType // \"unknown\"
" "$SESSION" 2>/dev/null | sort | uniq -c | sort -rn | sed 's/^/  /'

TOTAL=$(jq -r "select(.type==\"custom\" or .type==\"custom_message\") ${TFILTER} | .id" "$SESSION" 2>/dev/null | wc -l | tr -d ' ')
echo "  total: $TOTAL"
