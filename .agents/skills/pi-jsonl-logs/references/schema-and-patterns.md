# Pi Session Schema & Advanced Patterns

## Complete Entry Type Reference

### SessionHeader (first line, no id/parentId)
```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

### SessionMessageEntry
```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"...","message":{...}}
```
Message roles and their content shapes:

| Role | Content type | Notes |
|------|-------------|-------|
| `user` | `string` OR `(TextContent \| ImageContent)[]` | String for plain text, array when images included |
| `assistant` | `(TextContent \| ThinkingContent \| ToolCall)[]` | Always array |
| `toolResult` | `(TextContent \| ImageContent)[]` | From tool execution |
| `bashExecution` | (special fields) | `command`, `output`, `exitCode`, `cancelled`, `truncated` |
| `custom` | `string \| (TextContent \| ImageContent)[]` | Extension-injected |
| `branchSummary` | — | In `summary` field |
| `compactionSummary` | — | In `summary` field |

### Content block types
```
TextContent:      { type: "text", text: string }
ThinkingContent:  { type: "thinking", thinking: string, thinkingSignature: string }
ImageContent:     { type: "image", data: string (base64), mimeType: string }
ToolCall:         { type: "toolCall", id: string, name: string, arguments: object }
```

### Usage object (on assistant messages)
```json
{
  "input": 3,
  "output": 340,
  "cacheRead": 33866,
  "cacheWrite": 29986,
  "totalTokens": 34209,
  "cost": {
    "input": 0.000009,
    "output": 0.0051,
    "cacheRead": 0.00339,
    "cacheWrite": 0.1124,
    "total": 0.121
  }
}
```

### Other entry types
```json
{"type":"model_change","id":"...","parentId":"...","provider":"anthropic","modelId":"claude-sonnet-4-6"}
{"type":"thinking_level_change","id":"...","parentId":"...","thinkingLevel":"high"}
{"type":"compaction","id":"...","parentId":"...","summary":"...","firstKeptEntryId":"...","tokensBefore":50000}
{"type":"branch_summary","id":"...","parentId":"...","fromId":"...","summary":"..."}
{"type":"custom","id":"...","parentId":"...","customType":"my-extension","data":{}}
{"type":"custom_message","id":"...","parentId":"...","customType":"...","content":"...","display":true}
{"type":"label","id":"...","parentId":"...","targetId":"...","label":"checkpoint-1"}
{"type":"session_info","id":"...","parentId":"...","name":"Refactor auth module"}
```

#### Common customType values in real sessions

| customType | Entry type | Data fields | Notes |
|------------|-----------|-------------|-------|
| `agent-mode` | custom | `mode`, `planReviewPending`, `planReviewApproved` | Current agent mode (kuafu, plan, etc.) |
| `subagents:record` | custom | `id`, `type`, `description`, `status`, `result`, `startedAt`, `completedAt` | Full subagent completion record |
| `web-search-results` | custom | `id`, `timestamp`, `type`, `urls` | Search results metadata |
| `subagent-notification` | custom_message | XML task notification content | Displayed as agent completion notification |
| `ultrawork` | custom_message | Activation message content | Hidden (`display: false`) |

---

## Advanced jq Patterns

### Safe user content extraction
User `.content` can be string or array — always handle both:
```bash
jq -r 'select(.type=="message" and .message.role=="user") |
  .message.content |
  if type == "string" then .
  elif type == "array" then map(select(.type=="text") | .text) | join("\n")
  else "" end' session.jsonl
```

### Extract all tool calls with full arguments (compact)
```bash
jq -c 'select(.type=="message" and .message.role=="assistant") |
  .message.content[] | select(.type=="toolCall") |
  {turn_ts: parent.timestamp, name, arguments}' session.jsonl
# Note: parent. is jq 1.7+; use -s and reindex if on older jq
```

### Find all bash commands run
```bash
jq -r 'select(.type=="message" and .message.role=="toolResult" and .message.toolName=="bash") |
  # Get the corresponding tool call to find the command
  .message.toolCallId' session.jsonl
# Better: extract from the assistant toolCall entries directly:
jq -r 'select(.type=="message" and .message.role=="assistant") |
  .message.content[] | select(.type=="toolCall" and .name=="bash") |
  .arguments.command' session.jsonl
```

### Reconstruct conversation with tool call/result pairs
```bash
jq -r 'select(.type=="message") | 
  if .message.role=="user" then
    "\n--- USER [\(.timestamp)] ---\n" + (.message.content | if type=="string" then . else map(select(.type=="text")|.text)|join("") end)
  elif .message.role=="assistant" then
    "\n--- ASSISTANT [\(.timestamp)] model=\(.message.model) cost=$\(.message.usage.cost.total) ---\n" +
    ([.message.content[] | 
      if .type=="text" then .text
      elif .type=="toolCall" then "\n[TOOL CALL: \(.name)]\n\(.arguments | tostring)"
      else "" end
    ] | join(""))
  elif .message.role=="toolResult" then
    "\n[TOOL RESULT: \(.message.toolName) error=\(.message.isError)]\n" +
    ([.message.content[] | select(.type=="text") | .text] | join(""))
  else empty end' session.jsonl
```

### Token efficiency: how much is thinking?
```bash
jq -rs '
  [.[] | select(.type=="message" and .message.role=="assistant") |
    {
      thinking_chars: ([.message.content[] | select(.type=="thinking") | .thinking | length] | add // 0),
      text_chars: ([.message.content[] | select(.type=="text") | .text | length] | add // 0),
      tool_chars: ([.message.content[] | select(.type=="toolCall") | .arguments | tostring | length] | add // 0)
    }
  ] | {
    total_thinking: (map(.thinking_chars) | add),
    total_text: (map(.text_chars) | add),
    total_tool_args: (map(.tool_chars) | add)
  }' session.jsonl
```

### Find specific file edits across a session
```bash
jq -r 'select(.type=="message" and .message.role=="assistant") |
  .message.content[] | select(.type=="toolCall" and (.name=="edit" or .name=="write")) |
  .arguments.path' session.jsonl | sort -u
```

### Cross-session: cost per project
```bash
find ~/.pi/agent/sessions -name "*.jsonl" | while read f; do
  project=$(echo "$f" | sed 's|.*/--||;s|--/.*||;s|-|/|g')
  cost=$(jq -rs '[.[] | select(.type=="message" and .message.role=="assistant") | .message.usage.cost.total // 0] | add // 0' "$f")
  echo "$cost $project $f"
done | awk '{sum[$2]+=$1} END {for(p in sum) print sum[p], p}' | sort -rn
```

### Session directory path encoding
Working directory → session directory name:
```
/Users/zshen/work/my-app  →  --Users-zshen-work-my-app--
```
Decode:
```bash
# From session dir name to path (approximate — only works for simple paths)
echo "--Users-zshen-work-my-app--" | sed 's/^--//;s/--$//;s/-/\//g'
```
Encode from cwd:
```bash
SESSION_DIR="--$(pwd | sed 's|^/||;s|/|-|g')--"
```

### Multi-session grep: find when a file was last touched
```bash
grep -rl '"path":"src/my-file.ts"' ~/.pi/agent/sessions/**/*.jsonl 2>/dev/null |
  xargs -I{} sh -c 'echo "$(jq -r ".timestamp" {} | head -1) {}"' | sort -r | head -5
```

### Compaction: what was preserved
```bash
jq -r 'select(.type=="compaction") | 
  "Compacted \(.tokensBefore) tokens. First kept: \(.firstKeptEntryId)\nSummary: \(.summary[:400])"' session.jsonl
```

---

## File Size vs. Content Guide

From real session data (125 sessions, avg 210KB):

| What you extract | Typical size | vs. raw file |
|-----------------|-------------|-------------|
| Full raw file | 200KB | 100% |
| Full conversation (no thinking, no base64) | ~46% | saves ~54% |
| User + assistant text only | ~8% | saves ~92% |
| User messages only | ~1% | saves ~99% |
| Token stats only | <1KB | saves ~99.9% |

Thinking blocks alone account for 30–60% of a typical file's bytes.

---

## Common Mistakes

**Mistake: Using `jq --stream`**  
Pi sessions are small (< 2MB). `--stream` adds complexity with no benefit. Plain line-by-line is always sufficient.

**Mistake: Forgetting that user `.content` can be string or array**  
Always guard: `if type=="string" then . else map(select(.type=="text")|.text)|join("") end`

**Mistake: Missing compaction when reconstructing thread**  
If a session has compaction entries, the earliest messages before `firstKeptEntryId` are gone. Check:
```bash
jq -r 'select(.type=="compaction") | .firstKeptEntryId' session.jsonl
```

**Mistake: Assuming `.message.role` covers bashExecution**  
`bashExecution` entries have their own top-level `role` field but `type="message"`. Filter:
```bash
jq 'select(.type=="message" and .message.role=="bashExecution")' session.jsonl
```
