# Modes Extension

Status: shipped

The modes extension implements agent persona switching for three modes — **Kua Fu 夸父** (build), **Fu Xi 伏羲** (plan), and **Hou Tu 后土** (execute). It manages mode-specific tool restrictions, system prompt injection, plan state, approval, and the handoff bridge to execution.

For the practical plan and build lifecycles, see [orchistration.md](../guides/orchistration.md).

---

## Modes

| Mode | Alias | Purpose |
|------|-------|---------|
| `kuafu` | `build` | Default. General-purpose coding and implementation. |
| `fuxi` | `plan` | Plan drafting with restricted tool access. Write/edit is limited to `PLAN.md`/`DRAFT.md`; built-in `bash` is guarded by `smart-tool-guards`. |
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

## Model Override

The `/mode-model` command provides a session-scoped model override that takes precedence over the mode's frontmatter `model` chain:

| Command | Behavior |
|---------|----------|
| `/mode-model` | Displays current mode, active override (if any), configured fallback chain, and active model. |
| `/mode-model <spec>` | Sets override to `<spec>`. Validates against the model registry before applying. Example: `/mode-model anthropic/claude-sonnet-4:high`. |
| `/mode-model --reset` | Clears the override and re-applies the mode's configured `model` chain. |

The override is persisted in the session JSONL as `modelOverride` and survives `/reload`. It does **not** modify the mode's frontmatter. When switching modes, the override persists across the switch — use `--reset` to revert.

---

## Mode Configuration

Each mode reads its prompt and settings from `~/.pi/agent/modes/<mode>/mode.md` (repo source `modes/<mode>/mode.md`). The file uses YAML frontmatter for configuration and a markdown body for the system prompt injection. Model-family variants (`gpt.md`, `gemini.md`) live beside it and reuse the `mode.md` frontmatter.

### Frontmatter Fields

[`agent-frontmatter.ts`](../../extensions/lib/agent-frontmatter.ts) defines the frontmatter fields and how they are parsed. The [agent frontmatter guide](../guides/agent-frontmatter.md) explains how to author them. Mode-specific rules:

- `prompt_mode` has no effect on modes; see [Prompt Injection](#prompt-injection). Modes always run with project AGENTS.md present.
- `tools` is the mode's permission ceiling, not activation: Pi and owning extensions decide what's active; unpermitted tools are hidden from the model by `mode_tool_ceiling`, and every unpermitted call is blocked, top-level and nested. A mode file without `tools` permits no tools, and so does a missing or invalid mode file (whose errors are notified). `extensions` is an error in a mode file.
- `allow_nesting` permits nested subagent controls only when `tools` also grants them.
- `disallow_delegation_to` is applied as exclusions from `allow_delegation_to` when both are set.
- `model` is a model chain; the first available match wins ([model selection](model-selection-and-fallback.md)).

### Prompt Injection

On every top-level prompt, the active mode's body, with model-family overlays applied, becomes the `modes` system-prompt section (`<modes>…</modes>`), following the [extension prompt-section contract](../../extensions/AGENTS.md). Switching modes replaces that section. Pi records the change as a transcript delta instead of rewriting the prompt head. Subagent sessions get no mode section.

---

## Plan Mode Restrictions (Fu Xi)

When the active mode is `fuxi`, the modes extension's `tool_call` hook deterministically enforces the write/edit restriction below.

### Write/Edit Restrictions

`write` and `edit` tool calls are blocked unless the target path matches:

- `local://PLAN.md` or its resolved local path
- `local://DRAFT.md` or its resolved local path

### Bash Restrictions

Fu Xi exposes built-in `bash`. The modes extension registers a scope provider that requests `smart-tool-guards` guarding only when the latest active mode is `fuxi`; other modes abstain. Positive `smart-tool-guards:bash` capability registration is required, so missing or failed guard loading blocks Fu Xi `bash` before execution.

For guarded calls, malformed input and deterministic danger block first, exact trimmed `pwd` allows without model use, and all other commands defer to `smart-tool-guards.classifier`. Missing selection/model/auth, timeout or cancellation, provider errors, and malformed verdicts fail closed.

The guard preserves native command, cwd, timeout, and execution behavior after approval. It is an authorization guard, not a shell sandbox or security boundary. Mutable shell work requires switching to build mode.

### Delegation Restrictions

Mode frontmatter delegation rules are persisted in versioned `agent-mode` policy state. The subagent runtime consumes that policy for direct `agent` and RPC authorization; the modes hook does not guard `agent` calls.

---

## Plan State Tracking

The extension tracks plan state in memory via `ModeStateManager` and persists it to the session JSONL via `appendEntry("agent-mode", ...)`.

### Tracked State

`ModeState` in [`types.ts`](../../extensions/modes/src/types.ts) defines the tracked fields: the mode, plan title and content, and Plannotator review state. The Plannotator availability cache stays in memory and is not persisted.

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

- The installed Plannotator browser-review module is imported lazily.
- Availability probing checks that required functions and HTML assets are present.
- Starting a browser review records pending review state and an `awaitingUserAction` marker.
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

See [orchistration.md](../guides/orchistration.md) for the end-to-end user workflow.

---

## Session Persistence

Mode state survives pi restarts through two mechanisms.

### Session JSONL Entries

`appendEntry("agent-mode", state)` writes the persisted `ModeState` object to the session file. On `session_start`, the extension restores the latest `agent-mode` entry, including the mode, plan state, review state, and `modelOverride`.

### Local Plan File

`PLAN.md` and `DRAFT.md` are stored in session-local storage. On session start, `hydratePlanState` reads the plan file from disk and reconciles it with restored session state, preferring the on-disk H1 title over the cached title.

### CLI Flag Override

The `--mode` flag takes precedence over session-restored mode. If a flag is provided and is not the default `kuafu`, the session-restored mode is ignored.

### Model Restoration


On session start, the mode's model is applied via `applyModelFromConfig`. If pi then restores the session's saved model (for example, when resuming a session), the `model_select` hook detects `source === "restore"` and re-applies the mode's model — ensuring the mode's configured chain (or active override) takes precedence over the session's last-used model.
### Review Recovery

On session start, if a pending Plannotator review ID exists in restored state, recovery clears it because browser review sessions do not survive the restart. It also clears the related `awaitingUserAction` marker and notifies the user when UI is available.

---

## Source

The implementation lives in [`extensions/modes/src/`](../../extensions/modes/src/).
