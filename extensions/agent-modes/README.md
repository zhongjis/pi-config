# @danchamorro/pi-agent-modes

Agent modes for [pi](https://github.com/badlogic/pi-mono). This vendored copy adds a shared `plan` mode, a tab-style widget above the editor, and a richer runtime API/events bridge so `extensions/plan-mode/` can reuse the same mode state and publish planner progress.

## Modes

| Mode | Built-in tools | Bash | Edits | Purpose |
|------|---------------|------|-------|---------|
| **Code** | All | Unrestricted | All files | Default. Write, modify, or refactor code. |
| **Plan** | read, bash, grep, find, ls | Read-only allowlist | None | Shared planning mode used by `extensions/plan-mode/`. |
| **Architect** | read, bash, edit, write, grep, find, ls | Read-only allowlist | `.md`, `.mdx` only | Plan, design, and strategize before implementation. |
| **Debug** | All | Unrestricted | All files | Systematic problem diagnosis and resolution. |
| **Ask** | read, bash, grep, find, ls | Read-only allowlist | None | Q&A: explanations, research, and documentation. |
| **Review** | read, bash, grep, find, ls | Review-safe allowlist | None | Code review with structured feedback. |

Each mode has a distinct PI persona, a short description shown in the widget, and mode-specific custom instructions that guide the agent's behavior.

The table above covers Pi's built-in tools. Extension tools and MCP tools remain visible, so information-gathering integrations continue to work inside restricted modes.

### Mode widget

The active mode displays a tab-style widget in the UI:

```
[code]  PLAN  [architect] [debug] [ask] [review]
Planning status from `extensions/plan-mode/` replaces the generic description while plan mode is active.
bash:read-only | edit:off · /agent-mode · ctrl+shift+m
```

The first line is a mode strip. The second line is the active mode description. The third line shows the current restrictions, plus model/thinking overrides when present.

## Install

```bash
pi install npm:@danchamorro/pi-agent-modes
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:@danchamorro/pi-agent-modes"]
}
```

## Usage

**Command:**

```
/agent-mode              Show mode selector
/agent-mode code         Switch to code mode
/agent-mode plan         Switch to plan mode
/agent-mode architect    Switch to architect mode
/agent-mode debug        Switch to debug mode
/agent-mode ask          Switch to ask mode
/agent-mode review       Switch to review mode
/agent-mode off          Disable agent modes and restore default behavior
/agent-mode setup        Assign models and thinking levels per mode
```

**Keyboard shortcut:**

`Ctrl+Shift+M` cycles through all modes, then `off`.

**CLI flag:**

```bash
pi --agent-mode architect
```

## How enforcement works

Enforcement is layered, not just prompt guidance:

1. **Tool visibility:** `setActiveTools()` controls which built-in tools the model can see. In ask mode, `edit` and `write` do not exist for the model. `bash` remains available, but only through the restricted allowlist. Extension and MCP tools remain visible.
2. **Bash restrictions:** For architect, ask, and review modes, bash commands are validated against an allowlist at the `tool_call` level. Destructive commands (rm, git push, npm install, etc.) are blocked before execution. Piped and chained commands are also checked.
3. **File restrictions:** In architect mode, edit and write are restricted to markdown files (`.md`, `.mdx`). Other file types are blocked at the `tool_call` level.
4. **Prompt injection:** Each mode appends a behavioral prompt to the system prompt via `before_agent_start`, setting the agent's persona and custom instructions.

This vendored copy also publishes `globalThis.__piAgentModesApi`, including shared `getMode()` / `setMode()` and `getPlanState()` / `setPlanState()` methods, emits `agent-mode:changed`, and emits `agent-mode:plan-state-changed` on `pi.events`, so other local extensions can switch modes or observe planner progress without duplicating restriction logic.

## Model setup

By default, all modes use whatever model is active in your session. To assign specific models and thinking levels per mode, run:

```
/agent-mode setup
```

This walks through each mode, letting you pick a model and thinking level from your available models. Pressing Escape at any point cancels the setup. The configuration is saved to `~/.pi/agent/agent-modes.json`.

You can re-run setup at any time to change assignments. Selecting "No override" for a mode clears any previous assignment.

## Configuration

Override mode defaults with JSON config files. Project overrides take precedence over global, which take precedence over built-in defaults.

**Global:** `~/.pi/agent/agent-modes.json`
**Project:** `.pi/agent-modes.json`

### Example: assign models to modes

```json
{
  "architect": {
    "provider": "openai",
    "model": "o3",
    "thinkingLevel": "high"
  },
  "code": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "thinkingLevel": "medium"
  },
  "debug": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "thinkingLevel": "high"
  }
}
```

### Example: customize architect to allow shell scripts

```json
{
  "architect": {
    "editableExtensions": [".md", ".mdx", ".sh"]
  }
}
```

### Override fields

Each mode supports these overrides:

| Field | Type | Description |
|-------|------|-------------|
| `tools` | `string[]` or `"all"` | Tools visible to the model |
| `bash` | `"all"`, `"none"`, `"restricted"` | Bash access level |
| `editableExtensions` | `string[]` | File extensions allowed for edit/write |
| `prompt` | `string` | System prompt addition |
| `provider` | `string` | Model provider name |
| `model` | `string` | Model ID |
| `thinkingLevel` | `string` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |

## State persistence

The active mode, including `off`, is persisted across session restarts via `appendEntry`. When you resume a session, the mode state you last used is automatically restored.
