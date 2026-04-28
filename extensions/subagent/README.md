# Subagents

Claude Code-style autonomous sub-agents for Pi. Spawn specialized agents in isolated sessions with their own tools, model, thinking level, and system prompt. Run foreground or background, steer mid-run, resume completed sessions.

Vendored from [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) v0.6.3. See [CHANGELOG.md](CHANGELOG.md) for upstream history.

## Tools

### `Agent`

Spawn a new agent or resume an existing one.

**Parameters:**
- `prompt` (required): Task for the agent
- `description` (required): Short label shown in UI
- `subagent_type`: Agent type (default: `general-purpose`)
- `run_in_background`: Return immediately, notify on completion
- `resume`: Agent ID to continue from
- `model`: Model override (fuzzy: `"haiku"`, `"sonnet"`, or full `"provider/modelId"`)
- `thinking`: Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`)
- `max_turns`: Turn cap before graceful wrap-up
- `inherit_context`: Fork parent conversation into agent
- `isolated`: No extension/MCP tools
- `isolation`: `"worktree"` for git worktree isolation

### `get_subagent_result`

Check status or wait for a background agent. Returns full result text.

**Parameters:**
- `agent_id` (required)
- `wait`: Block until completion
- `verbose`: Include full conversation

### `steer_subagent`

Inject a message into a running agent's conversation.

**Parameters:**
- `agent_id` (required)
- `message` (required)

## Commands

- `/agents` — Interactive management menu: browse running agents, view conversations, create/edit/eject/disable custom agents, configure settings.

## Default Agent Types

| Type | Tools | Model | Prompt Mode |
|------|-------|-------|-------------|
| `general-purpose` | all | inherit | append (parent twin) |
| `Explore` | read, bash, grep, find, ls | haiku | replace (standalone) |
| `Plan` | read, bash, grep, find, ls | inherit | replace (standalone) |

Defaults can be overridden by creating `.pi/agents/<name>.md` with the same name, or ejected via `/agents` menu.

## Custom Agents

Define agents as `.md` files with YAML frontmatter. Filename = agent type name.

| Priority | Location |
|----------|----------|
| 1 (highest) | `.pi/agents/<name>.md` (project) |
| 2 | `$PI_CODING_AGENT_DIR/agents/<name>.md` (global, default `~/.pi/agent/agents/`) |

Example `.pi/agents/auditor.md`:

```markdown
---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
---

You are a security auditor. Review code for vulnerabilities.
Report findings with file paths, line numbers, severity, and remediation.
```

## Settings

Configured via `/agents` → Settings. Persisted to `<cwd>/.pi/subagents.json` (project) with global defaults from `~/.pi/agent/subagents.json`.

| Setting | Default | Description |
|---------|---------|-------------|
| Max concurrency | 4 | Background agent slots |
| Default max turns | unlimited | Turn cap for agents without explicit limit |
| Grace turns | 5 | Extra turns after wrap-up warning |
| Join mode | smart | Completion notification grouping (`async`, `group`, `smart`) |

## Events

Lifecycle events on `pi.events`:

- `subagents:created`, `subagents:started`, `subagents:completed`, `subagents:failed`, `subagents:steered`
- `subagents:ready` — broadcast on extension load
- `subagents:settings_loaded`, `subagents:settings_changed`

Cross-extension RPC: `subagents:rpc:ping`, `subagents:rpc:spawn`, `subagents:rpc:stop` with reply on `:reply:${requestId}`.

## Local Additions

Features added on top of upstream, not present in the published package:

- **Background supervision** (`background-supervision.ts`) — auto-steers idle agents after a timeout, auto-aborts after prolonged inactivity. Parent gets stale-agent reminders.
- **Delegation policy** (`delegation-policy.ts`) — `allow_delegation_to`, `disallow_delegation_to`, `allow_nesting` frontmatter fields control which agents a subagent may spawn.
- **Result recovery** (`result-recovery.ts`) — fallback text extraction from session history when `record.result` is empty (non-streaming providers, aborted agents).
- **ThinkingLevel normalizer** (`thinking-level.ts`) — maps legacy `"none"` → `"off"` for backward compatibility with existing agent frontmatter.
- **Enhanced skill loader** (`skill-loader.ts`) — Pi-aware skill discovery: `SKILL.md` directory skills, ancestor `.agents/skills/` traversal, frontmatter name matching, `sourcePath`/`baseDir` metadata for relative path resolution.
- **Abort signal forwarding** — external tool abort signals propagate into running/queued agents, enabling clean cancellation.
- **Model label tracking** — resolved `provider/model` label shown in widget for each agent.
