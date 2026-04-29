#!/usr/bin/env bash
# pi-session-errors.sh — Extract errors and failed tool calls
# Usage: pi-session-errors.sh <session.jsonl> [--compact]
#
# Shows:
#   - Tool results where isError==true (with tool name and output)
#   - Bash commands with non-zero exit codes (from toolResult content)
#
# Options:
#   --compact   One line per error (truncated)

set -euo pipefail

SESSION=""
COMPACT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compact) COMPACT=true; shift ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) SESSION="$1"; shift ;;
  esac
done

: "${SESSION:?Usage: pi-session-errors.sh <session.jsonl> [--compact]}"

if [[ ! -f "$SESSION" ]]; then
  echo "Error: file not found: $SESSION" >&2
  exit 1
fi

echo "=== Tool Errors (isError==true) ==="

if [[ "$COMPACT" == "true" ]]; then
  jq -r '
    select(.type=="message" and .message.role=="toolResult" and .message.isError==true) |
    "\(.timestamp) | \(.message.toolName) | " +
    ([.message.content[] | select(.type=="text") | .text] | join("") | gsub("\n"; " "))[:200]
  ' "$SESSION" 2>/dev/null
else
  jq -r '
    select(.type=="message" and .message.role=="toolResult" and .message.isError==true) |
    "[\(.timestamp)] \(.message.toolName)\n" +
    ([.message.content[] | select(.type=="text") | .text] | join("\n")) +
    "\n---"
  ' "$SESSION" 2>/dev/null
fi

ERROR_COUNT=$(jq -r 'select(.type=="message" and .message.role=="toolResult" and .message.isError==true) | .id' "$SESSION" 2>/dev/null | wc -l | tr -d ' ')

echo ""
echo "=== Bash Non-Zero Exits ==="

# Structural: bashExecution entries with exitCode > 0
BASH_EXEC_ERRORS=$(jq -r '
  select(.type=="message" and .message.role=="bashExecution") |
  select(.message.exitCode != null and .message.exitCode > 0) |
  if '"$COMPACT"' then
    "\(.timestamp) | bash (exit \(.message.exitCode)) | " + (.message.command // "?")[:200]
  else
    "[\(.timestamp)] bash exit=\(.message.exitCode)\n  cmd: \(.message.command // "?")\n  out: \((.message.output // "")[:400])\n---"
  end
' "$SESSION" 2>/dev/null)

# Regex fallback: bash tool results with exit code in text
BASH_TOOL_ERRORS=$(jq -r '
  select(.type=="message" and .message.role=="toolResult" and .message.toolName=="bash") |
  ([.message.content[] | select(.type=="text") | .text] | join("")) as $out |
  select($out | test("(Command exited with code [1-9]|exit(ed with)? (code |status )[1-9])"; "i")) |
  if '"$COMPACT"' then
    "\(.timestamp) | bash | " + ($out | split("\n") | map(select(test("exit|code [1-9]"; "i"))) | first // $out[:200])
  else
    "[\(.timestamp)] bash\n" + $out[:500] + "\n---"
  end
' "$SESSION" 2>/dev/null)

if [[ -n "$BASH_EXEC_ERRORS" ]]; then echo "$BASH_EXEC_ERRORS"; fi
if [[ -n "$BASH_TOOL_ERRORS" ]]; then echo "$BASH_TOOL_ERRORS"; fi

BASH_EXEC_COUNT=$(jq '[.[] | select(.type=="message" and .message.role=="bashExecution" and .message.exitCode != null and .message.exitCode > 0)] | length' -s "$SESSION" 2>/dev/null)
BASH_TOOL_COUNT=$(jq '[
  .[] | select(.type=="message" and .message.role=="toolResult" and .message.toolName=="bash") |
  ([.message.content[] | select(.type=="text") | .text] | join("")) |
  select(test("(Command exited with code [1-9]|exit(ed with)? (code |status )[1-9])"; "i"))
] | length' -s "$SESSION" 2>/dev/null)

echo ""
echo "--- Summary ---"
echo "  tool errors:       $ERROR_COUNT"
echo "  bash exec errors:  ${BASH_EXEC_COUNT:-0}"
echo "  bash tool errors:  ${BASH_TOOL_COUNT:-0}"

# Error frequency by tool name
TOOL_FREQ=$(jq -r 'select(.type=="message" and .message.role=="toolResult" and .message.isError==true) | .message.toolName' "$SESSION" 2>/dev/null | sort | uniq -c | sort -rn)
if [[ -n "$TOOL_FREQ" ]]; then
  echo "  by tool:"
  echo "$TOOL_FREQ" | sed 's/^/    /'
fi
