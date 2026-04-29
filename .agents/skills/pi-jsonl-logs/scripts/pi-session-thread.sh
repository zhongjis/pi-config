#!/usr/bin/env bash
# pi-session-thread.sh — Conversation thread with timestamps
# Usage: pi-session-thread.sh <session.jsonl> [--max-chars N] [--head N] [--tail N] [--tools] [--no-empty]
#
# Options:
#   --max-chars N   Truncate each message to N chars (default: 300)
#   --head N        Show first N messages only
#   --tail N        Show last N messages only
#   --tools         Include tool calls and results (default: user+assistant text only)
#   --no-empty      Skip assistant messages with empty content (thinking-only or blank)
#
# Each message is collapsed to a single line, so --head/--tail count messages.

set -euo pipefail

SESSION=""
MAX_CHARS=300
HEAD=""
TAIL=""
SHOW_TOOLS=false
NO_EMPTY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-chars) MAX_CHARS="$2"; shift 2 ;;
    --head) HEAD="$2"; shift 2 ;;
    --tail) TAIL="$2"; shift 2 ;;
    --tools) SHOW_TOOLS=true; shift ;;
    --no-empty) NO_EMPTY=true; shift ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) SESSION="$1"; shift ;;
  esac
done

: "${SESSION:?Usage: pi-session-thread.sh <session.jsonl> [--max-chars N] [--head N] [--tail N] [--tools] [--no-empty]}"

if [[ ! -f "$SESSION" ]]; then
  echo "Error: file not found: $SESSION" >&2
  exit 1
fi

# Use --argjson to pass max_chars; use --arg to pass show_tools and no_empty flags
# All messages collapsed to single lines so head/tail = message count
OUTPUT=$(jq -r --argjson max "$MAX_CHARS" --arg tools "$SHOW_TOOLS" --arg noempty "$NO_EMPTY" '
  def collapse: gsub("\n"; " ");
  def trunc: .[:$max];

  select(.type=="message") |

  # Role filter
  if $tools == "true" then .
  elif .message.role == "user" or .message.role == "assistant" or .message.role == "bashExecution" then .
  else empty end |

  # Empty content filter
  if $noempty == "true" and .message.role == "assistant" and (.message.content | length == 0) then empty
  else . end |

  if .message.role == "user" then
    "\(.timestamp) | USER | " +
    (.message.content |
      if type == "string" then trunc
      else (map(select(.type=="text") | .text) | join("")) | trunc
      end | collapse)
  elif .message.role == "assistant" then
    "\(.timestamp) | ASST | " +
    (([.message.content[] |
      if .type == "text" then .text
      elif .type == "toolCall" then "[TOOL:\(.name)]"
      else empty end
    ] | join(" ")) | trunc | collapse)
  elif .message.role == "toolResult" then
    "\(.timestamp) | RESULT:\(.message.toolName) err=\(.message.isError) | " +
    (([.message.content[] | select(.type=="text") | .text] | join("")) | trunc | collapse)
  elif .message.role == "bashExecution" then
    "\(.timestamp) | BASH | " +
    ((.message.command // "?") | trunc | collapse) +
    (if .message.exitCode != null and .message.exitCode > 0 then " [exit \(.message.exitCode)]" else "" end)
  else empty end
' "$SESSION" 2>/dev/null)

# Apply head/tail (each message = one line, so head/tail count messages)
if [[ -n "$HEAD" ]]; then
  echo "$OUTPUT" | head -"$HEAD"
elif [[ -n "$TAIL" ]]; then
  echo "$OUTPUT" | tail -"$TAIL"
else
  echo "$OUTPUT"
fi
