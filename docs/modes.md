# Modes Extension

The modes extension implements agent persona switching for three modes — **Kua Fu 夸父** (build), **Fu Xi 伏羲** (plan), and **Hou Tu 后土** (execute). It manages mode-specific tool restrictions, system prompt injection, plan lifecycle orchestration, and the approval flow that bridges planning to execution.

For the broader plan lifecycle (drafting → gap review → approval → handoff → execution), see [orchestration-flow.md](orchestration-flow.md).

---

## Modes

| Mode | Alias | Purpose |
|------|-------|---------|
| `kuafu` | `build` | Default. General-purpose coding and implementation. |
| `fuxi` | `plan` | Plan drafting with restricted tool access. Write/edit limited to `PLAN.md`/`DRAFT.md`, bash limited to read-only commands. |
| `houtu` | `execute` | Plan execution after handoff. Receives a prepared briefing from the plan phase. |

---

## Mode Switching

Six ways to switch modes:

| Method | Example | Notes |
|--------|---------|-------|
| **`/mode` command** | `/mode fuxi` | Interactive selector when called with no arguments. Accepts mode names or aliases. |
| **`/mode:<name>` shortcut** | `/mode:plan do the thing` | Switches mode, then delivers any trailing text as a follow-up message. Works with names (`fuxi`) and aliases (`plan`). |
| **Keyboard shortcut** | `Ctrl+Shift+M` | Cycles through modes in order: kuafu → fuxi → houtu → kuafu. |
| **Tab in empty editor** | Press `Tab` with no text | Same cycle behavior as Ctrl+Shift+M. |
| **Bare word input** | Type `fuxi` or `plan` | Transformed into `/mode:fuxi` before submission. Recognized words: all mode names and aliases. |
| **CLI `--mode` flag** | `pi --mode fuxi` | Sets the initial mode at startup. Overrides session-restored mode. |

---

## Mode Configuration

Each mode reads its prompt and settings from `~/.pi/agent/agents/<mode>.md`. The file uses YAML frontmatter for configuration and markdown body for the system prompt injection.

### Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `prompt_mode` | `"append"` \| `"replace"` | How the mode body is injected into the system prompt. `append` (default) adds after existing prompt. `replace` strips previous mode bodies first. |
| `tools` | comma-separated strings | Allowlist of tool names. When set, only these tools (plus `extensions`) are active. |
| `extensions` | comma-separated strings \| `true` | Extension-provided tools to include. `true` includes all. A list includes only named tools. |
| `disallowed_tools` | comma-separated strings | Tools to remove from the active set (applied after allowlist). |
| `allow_delegation_to` | comma-separated strings | Allowlist of subagent types the mode may delegate to. |
| `disallow_delegation_to` | comma-separated strings | Blocklist of subagent types. Applied as exclusions from `allow_delegation_to` when both are set. |
| `model` | string | Model override. Resolved by exact `provider/modelId`, exact `modelId`, or starts-with prefix match. |

### Prompt Injection

The mode body is wrapped in HTML comment markers (`<!-- mode:<name> -->`) and injected into the system prompt. When `prompt_mode` is `replace`, any existing mode body markers are stripped before injection.

---

## Plan Mode Restrictions (Fu Xi)

When the active mode is `fuxi`, the `tool_call` hook enforces restrictions:

### Write/Edit Restrictions

`write` and `edit` tool calls are blocked unless the target path matches:
- `local://PLAN.md` or its resolved local path
- `local://DRAFT.md` or its resolved local path

### Bash Restrictions

`bash` tool calls are blocked unless the command starts with a recognized read-only prefix. Safe prefixes include:
- File inspection: `cat`, `head`, `tail`, `less`, `more`, `file`, `stat`
- Search: `grep`, `rg`, `find`, `fd`, `fzf`
- Directory listing: `ls`, `pwd`, `tree`
- Git read-only: `git status`, `git log`, `git diff`, `git branch`, `git show`, `git remote`, `git rev-parse`, `git describe`, `git tag`
- Package info: `npm list/outdated/info/view/ls`, `yarn info/list/why`, `pnpm list/outdated/why`
- System info: `uname`, `whoami`, `date`, `uptime`, `which`, `command -v`
- Text processing: `wc`, `sort`, `uniq`, `cut`, `awk`, `sed -n`, `jq`
- Output: `echo`, `printf`
- Nix: `nix`, `nh`
- Disk: `du`, `df`

### Delegation Restrictions

`Agent` tool calls are checked against `allow_delegation_to` / `disallow_delegation_to` from mode frontmatter. Blocked delegations return a descriptive reason listing permitted targets.

---

## Plan State Tracking

The extension tracks plan state in memory via `ModeStateManager` and persists it to the session JSONL via `appendEntry("agent-mode", ...)`.

### Tracked State

| Field | Description |
|-------|-------------|
| `mode` | Current active mode. |
| `planTitle` | Derived from the first H1 heading in `PLAN.md`, or explicitly set. |
| `planTitleSource` | How the title was derived: `"content-h1"`, `"explicit-exit"`, or `"cached-state"`. |
| `planContent` | Current plan file content snapshot. |
| `planReviewId` | ID of a pending Plannotator review. |
| `planReviewPending` | Whether a Plannotator review is in progress. |
| `planReviewApproved` | Whether the plan has been approved (by any mechanism). |
| `planReviewFeedback` | Feedback from a rejected Plannotator review. |

### Title Derivation

Plan title is extracted from the first H1 heading in the plan markdown (`# Title`). The regex matches a line starting with `#` followed by a space, allowing up to 3 leading spaces and stripping trailing ATX-style closing hashes.

### State Reset on Plan Edit

Any successful `write` or `edit` to `PLAN.md` triggers:
1. Re-read plan content from disk
2. Re-derive title from H1
3. Reset all review state (pending, approved, feedback)
4. Clear Plannotator availability cache
5. Persist updated state

This ensures edits to the plan always invalidate prior approvals.

---

## Approval Flow

After Fu Xi drafts a plan and Di Renjie completes gap review, the `plan_approve` tool presents an interactive approval menu.

### Menu Variants

**`post-gap-review`** (default) — shown after Di Renjie gap review:
1. Refine in System Editor ($VISUAL / $EDITOR)
2. Refine in Plannotator
3. High Accuracy Review (Yan Luo)
4. Approve

**`post-high-accuracy`** — shown after Yan Luo returns OKAY:
1. Refine in System Editor
2. Refine in Plannotator
3. Approve

### Menu Behavior

| Option | Behavior |
|--------|----------|
| **Approve** | Marks plan as approved, prepares handoff, sets editor text to `/handoff:start-work`, notifies user. |
| **High Accuracy Review** | Returns instructions for the agent to run Yan Luo as a subagent, loop until OKAY, then re-show the menu with `post-high-accuracy` variant. |
| **Refine in System Editor** | Suspends TUI, opens plan in `$VISUAL`/`$EDITOR`/`vi`. On save, re-hydrates plan state and re-shows the same menu variant. On cancel, re-shows menu. |
| **Refine in Plannotator** | Sends plan content to the Plannotator extension via IPC. Review result arrives asynchronously on the `plannotator:review-result` event channel. |

### Non-Interactive Mode

When no UI is available (e.g., CI/headless), the approval flow auto-approves and prepares the handoff immediately.

### Plannotator Integration

Communication with the Plannotator extension uses event-based IPC:
- **Request channel**: `plannotator:request` — sends review requests with a `respond` callback
- **Result channel**: `plannotator:review-result` — receives async review results
- **Timeout**: 5 seconds for request acknowledgment
- **Health check**: A sentinel review ID probes availability before showing the menu option

---

## Handoff Integration

When a plan is approved, the extension prepares for Hou Tu execution:

1. **`setPreparedHandoffArgsResolver`** — registers a callback with the handoff runtime. When `/handoff:start-work` fires, the resolver checks that mode is `fuxi`, plan is approved, and title exists, then returns the handoff args (goal built from plan path, target mode `houtu`, `summarize: false`).

2. **`prepareApprovedPlanHandoff`** — sets the editor text to `/handoff:start-work` and notifies the user with a completion message. The user sends the pre-filled command to trigger the actual handoff.

3. **Mode switch to Hou Tu** — the handoff runtime (owned by `extensions/handoff/`) handles the actual mode switch and execution kickoff. The modes extension does not start execution directly.

See [orchestration-flow.md](orchestration-flow.md) for the full handoff lifecycle including stale detection and consumption.

---

## Session Persistence

Mode state survives pi restarts through two mechanisms:

### Session JSONL Entries

`appendEntry("agent-mode", state)` writes the full `ModeState` object to the session file. On `session_start`, the extension replays session entries to find the latest `agent-mode` entry and restores:
- Current mode
- Plan title, title source, and content
- Review state (pending ID, pending flag, approved flag, feedback)

### Local Plan File

`PLAN.md` and `DRAFT.md` are stored in session-local storage (via the `session-local` extension). On session start, `hydratePlanState` reads the plan file from disk and reconciles it with the restored session state, preferring the on-disk H1 title over the cached title.

### CLI Flag Override

The `--mode` flag takes precedence over session-restored mode. If a flag is provided (and isn't the default `kuafu`), the session-restored mode is ignored.

### Review Recovery

On session start, if a pending Plannotator review ID exists in restored state, the extension probes Plannotator for the review status:
- **Completed**: processes the result immediately (approve or request refinement)
- **Pending**: leaves state as-is (review still in progress)
- **Missing**: clears stale review state and notifies user

---

## File Structure

```
extensions/modes/src/
  types.ts          Type definitions (Mode, ModeConfig, ModeState, plan/review types)
  constants.ts      Mode lists, aliases, colors, safe bash prefixes, file names, IPC channels
  config-loader.ts  Reads and parses agents/<mode>.md frontmatter and body
  mode-state.ts     ModeStateManager class — state, persistence, mode switching, tool filtering
  commands.ts       /mode command, /mode:<name> commands, bare word input, Ctrl+Shift+M, Tab, --mode flag
  hooks.ts          tool_call restrictions, tool_result plan-write detection, before_agent_start prompt injection, session lifecycle
  plan-storage.ts   PLAN.md/DRAFT.md read/write, title derivation, plan hydration
  plannotator.ts    Plannotator IPC, approval menu, system editor refinement, review recovery
  index.ts          Extension entry point — wires state, event listeners, plan_approve tool, commands, hooks
```
