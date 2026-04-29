#!/usr/bin/env bash
# pi-session-files.sh — Files read, written, and edited in a session
# Usage: pi-session-files.sh <session.jsonl> [--op TYPE] [--unique]
#
# Groups files by operation (read/write/edit) with deduplication per group.
#
# Options:
#   --op TYPE   Filter by operation: read, write, edit (default: all)
#   --unique    Just print unique file paths, no grouping

set -euo pipefail

SESSION=""
OP_FILTER=""
UNIQUE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --op) OP_FILTER="$2"; shift 2 ;;
    --unique) UNIQUE=true; shift ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) SESSION="$1"; shift ;;
  esac
done

: "${SESSION:?Usage: pi-session-files.sh <session.jsonl> [--op TYPE] [--unique]}"

if [[ ! -f "$SESSION" ]]; then
  echo "Error: file not found: $SESSION" >&2
  exit 1
fi

extract_paths() {
  local tool="$1"
  jq -r "
    select(.type==\"message\" and .message.role==\"assistant\") |
    .message.content[] |
    select(.type==\"toolCall\" and .name==\"${tool}\") |
    (.arguments | if type==\"string\" then fromjson else . end | .path // empty)
  " "$SESSION" 2>/dev/null | sort -u
}

if [[ "$UNIQUE" == "true" ]]; then
  # All unique paths from read/write/edit/grep/find/ls
  {
    if [[ -z "$OP_FILTER" || "$OP_FILTER" == "read" ]]; then extract_paths "read"; fi
    if [[ -z "$OP_FILTER" || "$OP_FILTER" == "write" ]]; then extract_paths "write"; fi
    if [[ -z "$OP_FILTER" || "$OP_FILTER" == "edit" ]]; then extract_paths "edit"; fi
    if [[ -z "$OP_FILTER" ]]; then
      extract_paths "grep"
      extract_paths "find"
      extract_paths "ls"
    fi
  } | sort -u
  exit 0
fi

show_group() {
  local label="$1" tool="$2"
  local paths
  paths=$(extract_paths "$tool")
  if [[ -n "$paths" ]]; then
    echo "=== ${label} ==="
    echo "$paths" | sed 's/^/  /'
    echo "  ($(echo "$paths" | wc -l | tr -d ' ') unique files)"
    echo ""
  fi
}

if [[ -z "$OP_FILTER" ]]; then
  show_group "Files Read" "read"
  show_group "Files Written" "write"
  show_group "Files Edited" "edit"
  show_group "Files Searched (grep)" "grep"
  show_group "Files Listed (find)" "find"
  show_group "Files Listed (ls)" "ls"
elif [[ "$OP_FILTER" == "read" ]]; then
  show_group "Files Read" "read"
elif [[ "$OP_FILTER" == "write" ]]; then
  show_group "Files Written" "write"
elif [[ "$OP_FILTER" == "edit" ]]; then
  show_group "Files Edited" "edit"
elif [[ "$OP_FILTER" == "grep" ]]; then
  show_group "Files Searched (grep)" "grep"
elif [[ "$OP_FILTER" == "find" ]]; then
  show_group "Files Listed (find)" "find"
elif [[ "$OP_FILTER" == "ls" ]]; then
  show_group "Files Listed (ls)" "ls"
else
  echo "Unknown op: $OP_FILTER (use read, write, edit, grep, find, or ls)" >&2
  exit 1
fi
