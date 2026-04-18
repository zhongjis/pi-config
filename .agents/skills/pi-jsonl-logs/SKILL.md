---
name: pi-jsonl-logs
description: Parse and analyze pi agent session logs (JSONL format). Use this skill whenever you need to read, query, summarize, or extract data from pi session files — including finding sessions for a project, extracting conversation threads, auditing tool usage, computing cost/token stats, or searching across sessions. Load this skill before touching any .jsonl file under ~/.pi/agent/sessions or similar session directories. Do NOT read raw session JSONL files directly — always use jq patterns from this skill to extract only what you need.
---

# Pi Session Log Analysis

Pi session logs are JSONL files (one JSON object per line). Raw files average 200KB — 90%+ is thinking blocks and tool outputs. Extract only what you need.

## Why scripts instead of inline jq

The `scripts/` directory has ready-to-run bash scripts for every common extraction. Use them as your default approach — not as a fallback after writing jq.

The reason: session logs have annoying structural quirks (`.arguments` is sometimes a string, sometimes an object; `.content` is sometimes a string, sometimes an array; timestamps need parsing for duration math). Every script already handles these. When you write jq from scratch, you'll hit at least one of these gotchas and waste turns debugging. The scripts also produce clean, consistently formatted output that's easier to present to users.

When the user provides a session path, set these two variables up front and reuse them:

```bash
SESSION="/path/to/session.jsonl"
SCRIPTS="<skill-dir>/scripts"
```

Replace `<skill-dir>` with the absolute path to this skill's directory.

## Workflow

1. **Set up paths** (SESSION and SCRIPTS variables)
2. **Run the overview script first** — it's cheap and gives you the full picture before you commit to deeper extractions
3. **Run targeted scripts** from the catalog below based on what you need. Run independent scripts in parallel.
4. **Fall back to inline jq** only for extractions no script covers. When you do, follow patterns from [references/schema-and-patterns.md](references/schema-and-patterns.md).

Do not `read` raw `.jsonl` files with the `read` tool — the output will be enormous and mostly useless thinking blocks.

---

## Script Catalog

All scripts: `bash "$SCRIPTS/<name>.sh" "$SESSION" [flags]`

### pi-session-overview.sh — One-shot session summary

Start here. Outputs entry types, roles, tool frequency, cost/tokens, model, duration.

```bash
bash "$SCRIPTS/pi-session-overview.sh" "$SESSION"
```

### pi-session-thread.sh — Conversation timeline

Compact single-line-per-message thread with timestamps. Shows user + assistant + bashExecution messages. Each message collapsed to one line, so `--head N`/`--tail N` count messages.

```bash
# First 10 messages
bash "$SCRIPTS/pi-session-thread.sh" "$SESSION" --head 10
# Last 5, including tool calls/results
bash "$SCRIPTS/pi-session-thread.sh" "$SESSION" --tail 5 --tools
# Wider truncation (default: 300 chars)
bash "$SCRIPTS/pi-session-thread.sh" "$SESSION" --max-chars 500
```

### pi-session-subagents.sh — Agent delegation extraction

Extracts all Agent tool calls with type, description, background flag, max_turns, prompt preview.

```bash
# All subagent calls
bash "$SCRIPTS/pi-session-subagents.sh" "$SESSION"
# Filter by type, show more prompt
bash "$SCRIPTS/pi-session-subagents.sh" "$SESSION" --type fuxi --prompt-len 500
# Hide prompts
bash "$SCRIPTS/pi-session-subagents.sh" "$SESSION" --prompt-len 0
```

### pi-session-toolcalls.sh — Filter and extract tool calls

Filter by tool name (regex), extract specific arg fields. Handles string/object arg ambiguity.

```bash
# All bash commands (compact, just the command text)
bash "$SCRIPTS/pi-session-toolcalls.sh" "$SESSION" --tool bash --field command --compact
# Files touched by read/write/edit
bash "$SCRIPTS/pi-session-toolcalls.sh" "$SESSION" --tool 'read|write|edit' --field path
# Agent calls with subagent type
bash "$SCRIPTS/pi-session-toolcalls.sh" "$SESSION" --tool Agent --field subagent_type --compact
# All tools, verbose
bash "$SCRIPTS/pi-session-toolcalls.sh" "$SESSION"
```

### pi-session-timing.sh — Measure time between events

Match by text pattern, tool name, or tool args. Finds first match for each endpoint.

```bash
# Tool arg match → text match
bash "$SCRIPTS/pi-session-timing.sh" "$SESSION" --from-tool-arg 'Agent:fuxi' --to 'skip fuxi'
# Tool to tool
bash "$SCRIPTS/pi-session-timing.sh" "$SESSION" --from-tool Agent --to-tool get_subagent_result
# Text to text
bash "$SCRIPTS/pi-session-timing.sh" "$SESSION" --from 'fix the bug' --to 'looks good'
```

### pi-session-errors.sh — Extract errors and failed tool calls

Shows all tool results where `isError==true`, plus bash commands with non-zero exit codes.

```bash
bash "$SCRIPTS/pi-session-errors.sh" "$SESSION"
# Compact (one line per error)
bash "$SCRIPTS/pi-session-errors.sh" "$SESSION" --compact
```

### pi-session-files.sh — Files read, written, and edited

Deduplicated list of all files touched, grouped by operation type.

```bash
bash "$SCRIPTS/pi-session-files.sh" "$SESSION"
# Just edited files
bash "$SCRIPTS/pi-session-files.sh" "$SESSION" --op edit
# Just unique paths (no grouping)
bash "$SCRIPTS/pi-session-files.sh" "$SESSION" --unique
```

### pi-session-tasks.sh — Task lifecycle extraction

Shows TaskCreate, TaskUpdate, and TaskExecute calls — tracks task subjects, status transitions, and completion.

```bash
bash "$SCRIPTS/pi-session-tasks.sh" "$SESSION"
```

---

## Finding Sessions

```bash
# List all project dirs (each dir = one working directory)
ls ~/.pi/agent/sessions/

# Sessions for the current project (strip leading /, replace / with -, wrap in --)
PROJECT_DIR="--$(pwd | sed 's|^/||;s|/|-|g')--"
ls ~/.pi/agent/sessions/${PROJECT_DIR}/ 2>/dev/null | sort -r | head -10

# Most recent session for current project
find ~/.pi/agent/sessions/${PROJECT_DIR} -name "*.jsonl" 2>/dev/null | sort -r | head -1

# Find sessions mentioning a topic
grep -rl "your-keyword" ~/.pi/agent/sessions/ 2>/dev/null | head -10
```

## Batch Analysis: Across All Sessions

```bash
# Cost summary across all sessions for a project
find ~/.pi/agent/sessions/--Users-zshen-work-my-app-- -name "*.jsonl" | while read f; do
  cost=$(jq -rs '[.[] | select(.type=="message" and .message.role=="assistant") | .message.usage.cost.total // 0] | add' "$f")
  lines=$(wc -l < "$f")
  echo "$cost  $lines lines  $f"
done | sort -rn

# Search for a function/file mention across sessions
grep -l "function_name" ~/.pi/agent/sessions/**/*.jsonl 2>/dev/null
```

## Inline jq Fallback

When no script covers what you need, write jq following the patterns in the reference doc. A few common extractions that aren't worth a dedicated script:

```bash
# User messages only — smallest possible context
jq -r 'select(.type=="message" and .message.role=="user") |
  .message.content |
  if type=="string" then . 
  else map(select(.type=="text") | .text) | join("") 
  end' "$SESSION"

# Cumulative cost
jq -rs '[.[] | select(.type=="message" and .message.role=="assistant") |
  .message.usage.cost.total // 0] | add' "$SESSION"

# Model used (most recent)
jq -r 'select(.type=="message" and .message.role=="assistant") | .message.model' "$SESSION" | tail -1
```

## Reference

For full schema, field definitions, and advanced patterns (tree traversal, multi-session diffs, extension entries):
→ [references/schema-and-patterns.md](references/schema-and-patterns.md)
