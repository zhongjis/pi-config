---
name: pi-jsonl-logs
description: Parse and analyze pi agent session logs (JSONL format). Use this skill whenever you need to read, query, summarize, or extract data from pi session files — including finding sessions for a project, extracting conversation threads, auditing tool usage, computing cost/token stats, or searching across sessions. Load this skill before touching any .jsonl file under ~/.pi/agent/sessions or similar session directories. Do NOT read raw session JSONL files directly — always use jq patterns from this skill to extract only what you need.
---

# Pi Session Log Parsing

Pi session logs are JSONL files (one JSON object per line). Reading raw files wastes 90%+ of context — real sessions average 200KB, with thinking blocks and tool outputs dominating. Always use `jq` to extract exactly what you need.

## Session Locations

```bash
# Default location (pi's built-in session dir)
~/.pi/agent/sessions/

# Project-specific (symlinked or custom config)
~/personal/pi-config/sessions/   # this repo's session dir

# Per-project subdirectory naming: slashes → hyphens, wrapped in --
# /Users/zshen/work/my-app  →  --Users-zshen-work-my-app--
```

## Step 1: Find Sessions

```bash
# List all project dirs (each dir = one working directory)
ls ~/.pi/agent/sessions/

# Sessions for the current project (replace path separators)
PROJECT_DIR=$(pwd | sed 's|/|-|g')
ls ~/.pi/agent/sessions/--${PROJECT_DIR}--/ 2>/dev/null | sort -r | head -10

# Most recent session for current project
find ~/.pi/agent/sessions/--${PROJECT_DIR}-- -name "*.jsonl" 2>/dev/null | sort -r | head -1

# Find sessions mentioning a topic
grep -rl "your-keyword" ~/.pi/agent/sessions/ 2>/dev/null | head -10
```

## Step 2: Quick Session Overview

Always start with this before diving deeper. Shows entry counts and basic metadata — cheap and fast.

```bash
SESSION=/path/to/session.jsonl

# Header: project, timestamp, version
jq -r 'select(.type=="session")' "$SESSION"

# Entry type breakdown
jq -r '.type' "$SESSION" | sort | uniq -c | sort -rn

# Message role breakdown
jq -r 'select(.type=="message") | .message.role' "$SESSION" | sort | uniq -c

# Session name (if set via /name)
jq -r 'select(.type=="session_info") | .name' "$SESSION" | tail -1

# Total cost (sum all assistant turns)
jq -rs '[.[] | select(.type=="message" and .message.role=="assistant") | .message.usage.cost.total // 0] | add' "$SESSION"
```

## Step 3: Extract What You Need

### Conversation thread (most common use case)

```bash
# User messages only — smallest possible context
jq -r 'select(.type=="message" and .message.role=="user") |
  .message.content |
  if type=="string" then . 
  else map(select(.type=="text") | .text) | join("") 
  end' "$SESSION"

# Full conversation: user + assistant text, NO thinking blocks, NO base64
jq -r 'select(.type=="message") |
  if .message.role=="user" then
    "USER: " + (.message.content | if type=="string" then . else map(select(.type=="text") | .text) | join("") end)
  elif .message.role=="assistant" then
    "ASSISTANT: " + ([.message.content[] | select(.type=="text") | .text] | join(""))
  else empty end' "$SESSION"

# Compact conversation with timestamps
jq -c 'select(.type=="message" and (.message.role=="user" or .message.role=="assistant")) | {
  ts: .timestamp,
  role: .message.role,
  text: (.message.content | if type=="string" then . else (map(select(.type=="text") | .text) | join("")) end)
}' "$SESSION"
```

### Tool usage

```bash
# All tool calls with arguments
jq -r 'select(.type=="message" and .message.role=="assistant") |
  .message.content[] | select(.type=="toolCall") |
  [.name, (.arguments | tostring)] | @tsv' "$SESSION"

# Tool call frequency
jq -r 'select(.type=="message" and .message.role=="assistant") |
  .message.content[] | select(.type=="toolCall") | .name' "$SESSION" |
  sort | uniq -c | sort -rn

# Tool results (text only, skip base64/images)
jq -r 'select(.type=="message" and .message.role=="toolResult") | {
  tool: .message.toolName,
  isError: .message.isError,
  output: ([.message.content[] | select(.type=="text") | .text] | join(""))
}' "$SESSION"

# Errors only
jq -r 'select(.type=="message" and .message.role=="toolResult" and .message.isError==true) | {
  tool: .message.toolName,
  error: ([.message.content[] | select(.type=="text") | .text] | join(""))
}' "$SESSION"
```

### Token and cost analytics

```bash
# Per-turn breakdown: id, input, output, cacheRead, total, cost
jq -r 'select(.type=="message" and .message.role=="assistant") |
  [.id, .message.usage.input, .message.usage.output, .message.usage.cacheRead, .message.usage.totalTokens, .message.usage.cost.total] |
  @csv' "$SESSION"

# Cumulative cost
jq -rs '[.[] | select(.type=="message" and .message.role=="assistant") |
  .message.usage.cost.total // 0] | add' "$SESSION"

# Model used (most recent)
jq -r 'select(.type=="message" and .message.role=="assistant") | .message.model' "$SESSION" | tail -1

# Thinking block sizes (chars) — often 2000–5000 chars each
jq -r 'select(.type=="message" and .message.role=="assistant") |
  .message.content[] | select(.type=="thinking") | .thinking | length' "$SESSION"
```

### Session tree / branching

```bash
# Trace the entry chain (id → parentId links)
jq -r 'select(.id != null) | [.id, .parentId // "ROOT", .type] | @tsv' "$SESSION"

# Compaction events (where context was summarized)
jq -r 'select(.type=="compaction") | {id, tokensBefore, firstKeptEntryId, summary: .summary[:200]}' "$SESSION"

# Branch summary entries
jq -r 'select(.type=="branch_summary") | {id, fromId, summary: .summary[:200]}' "$SESSION"
```

## Batch: Across All Sessions

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

## What NOT to Do

| ❌ Bad | ✅ Good |
|--------|---------|
| `read` the raw `.jsonl` file | `jq` extract only needed fields |
| Load whole file to "understand structure" | Use `jq -r '.type' file \| sort \| uniq -c` |
| Read thinking blocks | `select(.type=="text")` to skip them |
| Include base64 image data | `select(.type != "image")` |
| Process multiple sessions in one `read` | Loop with `jq` extracts |

## Reference

For full schema, field definitions, and advanced patterns (tree traversal, multi-session diffs, extension entries):
→ [references/schema-and-patterns.md](references/schema-and-patterns.md)
