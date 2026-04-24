# Modes Extension

The modes extension implements agent persona switching for three modes — **Kua Fu 夸父** (build), **Fu Xi 伏羲** (plan), and **Hou Tu 后土** (execute). It manages mode-specific tool restrictions, system prompt injection, plan state, approval, and the handoff bridge to execution.

For the broader plan lifecycle, see [orchestration-flow.md](orchestration-flow.md).

---

## Modes

| Mode | Alias | Purpose |
|------|-------|---------|
| `kuafu` | `build` | Default. General-purpose coding and implementation. |
| `fuxi` | `plan` | Plan drafting with restricted tool access. Write/edit limited to `PLAN.md`/`DRAFT.md`, bash limited to read-only commands. |
| `houtu` | `execute` | Plan execution after handoff. Receives a prepared execution prompt in a child session. |

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
| `disallowed_tools` | comma-separated strings | Tools to remove from the active set after allowlist processing. |
| `allow_delegation_to` | comma-separated strings | Allowlist of subagent types the mode may delegate to. |
| `disallow_delegation_to` | comma-separated strings | Blocklist of subagent types. Applied as exclusions from `allow_delegation_to` when both are set. |
| `model` | string | Model override. Resolved by exact `provider/modelId`, exact `modelId`, or starts-with prefix match. |

### Prompt Injection

The mode body is wrapped in HTML comment markers (`<!-- mode:<name> -->`) and injected into the system prompt. When `prompt_mode` is `replace`, any existing mode body markers are stripped before injection.

---

## Plan Mode Restrictions (Fu Xi)

When the active mode is `fuxi`, the `tool_call` hook enforces restrictions.

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
| `pendingPlanReviewId` | Runtime field for a pending Plannotator browser review ID. Persists as `planReviewId`. |
| `planReviewPending` | Whether a Plannotator browser review is in progress. |
| `awaitingUserAction` | Persisted wait marker, used for pending browser review with `suppressContinuationReminder`. |
| `planReviewApproved` | Whether the plan has been approved by the current approval flow. |
| `planReviewFeedback` | Feedback from a rejected Plannotator review. |
| `plannotatorAvailable` / `plannotatorUnavailableReason` | In-memory availability cache; not persisted. |

### Title Derivation

Plan title is extracted from the first H1 heading in the plan markdown (`# Title`). The regex matches a line starting with `#` followed by a space, allowing up to 3 leading spaces and stripping trailing ATX-style closing hashes.

### State Reset on Plan Edit

Any successful `write` or `edit` to `PLAN.md` triggers:

1. Re-read plan content from disk
2. Re-derive title from H1
3. Reset review state only when no browser review is actively pending
4. Clear Plannotator availability cache so the next approval menu re-probes

A plan write during an active browser review does not clear the pending review state.

---

## Approval Flow

After Fu Xi writes the plan and follows the Di Renjie gap-review protocol, the `plan_approve` tool presents an approval menu.

### Menu Variants

**`post-gap-review`** (default):

1. Refine in System Editor
2. Refine in Plannotator
3. High Accuracy Review (Yan Luo)
4. Approve

**`post-high-accuracy`**:

1. Refine in System Editor
2. Refine in Plannotator
3. Approve

### Menu Behavior

| Option | Behavior |
|--------|----------|
| **Approve** | Marks plan as approved, prepares the handoff bridge, preloads `/handoff:start-work`, and tells the user to press Enter. |
| **High Accuracy Review** | Returns instructions for the agent to run Yan Luo as a subagent, loop until OKAY, then re-show the menu with `post-high-accuracy`. |
| **Refine in System Editor** | Suspends the TUI, opens the plan in `$VISUAL`/`$EDITOR`/`vi`, then resumes. On save, re-hydrates plan state and sends a follow-up refinement message with the diff instead of immediately re-showing the menu. On cancel, re-shows the same menu. |
| **Refine in Plannotator** | If unavailable, warns and re-shows the menu. If available, starts a browser review asynchronously, records pending review state, and returns `Got it, waiting on response from user`. |

When no UI is available, the flow auto-approves and prepares the handoff.

---

## Plannotator Integration

Plannotator uses direct browser-session integration, not event IPC.

- `plannotator-direct.ts` lazily imports the installed Plannotator browser-review module.
- Availability probing checks that required functions and HTML assets are present.
- `plannotator.ts` starts a direct browser review and stores `pendingPlanReviewId`, `planReviewPending`, and `awaitingUserAction`.
- The browser session's `onDecision` callback routes approval/rejection back to `handlePlanReviewResult`.
- On approval, the plan is marked approved and handoff preparation runs.
- On rejection, feedback is persisted and sent back to Fu Xi as a follow-up refinement request.
- On session restart, pending browser reviews are treated as lost; recovery clears stale pending review state and notifies the user instead of probing remote status.

---

## Handoff Integration

When a plan is approved, the modes extension prepares for Hou Tu execution without starting implementation:

1. `prepareApprovedPlanHandoff` persists approved plan state, registers a direct handoff bridge request for the current session when possible, preloads `/handoff:start-work`, and notifies the user.
2. The user must press Enter to send `/handoff:start-work`.
3. The handoff runtime resolves prepared args from the bridge or resolver, creates a new child session, seeds `agent-mode: houtu`, preloads a deterministic execution prompt, and waits for the user to press Enter in the child session.
4. The modes extension does not directly execute the plan, and the handoff runtime does not auto-send the execution prompt.

See [orchestration-flow.md](orchestration-flow.md) for the end-to-end lifecycle.

---

## Session Persistence

Mode state survives pi restarts through two mechanisms.

### Session JSONL Entries

`appendEntry("agent-mode", state)` writes the persisted `ModeState` object to the session file. On `session_start`, the extension replays session entries to find the latest `agent-mode` entry and restores:

- Current mode
- Plan title, title source, and content
- Review state (`planReviewId` restored into runtime `pendingPlanReviewId`, pending flag, approved flag, feedback)
- `awaitingUserAction`

### Local Plan File

`PLAN.md` and `DRAFT.md` are stored in session-local storage. On session start, `hydratePlanState` reads the plan file from disk and reconciles it with restored session state, preferring the on-disk H1 title over the cached title.

### CLI Flag Override

The `--mode` flag takes precedence over session-restored mode. If a flag is provided and is not the default `kuafu`, the session-restored mode is ignored.

### Review Recovery

On session start, if a pending Plannotator review ID exists in restored state, recovery clears it because browser review sessions do not survive the restart. It also clears the related `awaitingUserAction` marker and notifies the user when UI is available.

---

## File Structure

```
extensions/modes/src/
  types.ts                Type definitions (Mode, ModeConfig, ModeState, plan/review types)
  constants.ts            Mode lists, aliases, colors, safe bash prefixes, file names
  config-loader.ts        Reads and parses agents/<mode>.md frontmatter and body
  mode-state.ts           ModeStateManager class — state, persistence, mode switching, tool filtering
  commands.ts             /mode command, /mode:<name> commands, bare word input, Ctrl+Shift+M, Tab, --mode flag
  hooks.ts                tool_call restrictions, tool_result plan-write detection, prompt injection, session lifecycle
  plan-storage.ts         PLAN.md/DRAFT.md read/write, title derivation, plan hydration
  plan-approval.ts        Approval menu variants, editor refinement, high-accuracy instructions
  plannotator.ts          Direct browser review coordination, decision handling, handoff preparation, recovery
  plannotator-direct.ts   Direct Plannotator package import, availability probe, browser session start
  index.ts                Extension entry point — wires state, resolver, plan_approve tool, commands, hooks
```
