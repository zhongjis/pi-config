# Offline Mode Extension Design

## Goal

Add one new Pi extension that makes the current orchestration usable without internet access. Offline mode must keep the existing modes extension untouched, force local models, block web-dependent tools and agents, and tell both the user and the model that the session is offline.

## Non-goals

- Do not change `extensions/modes/`.
- Do not change `extensions/subagent/`.
- Do not edit agent frontmatter for the first version.
- Do not implement OS-level network blocking. Shell-command blocking is out of scope for the first version.
- Do not persist `/offline on` automatically. Session-only control is enough.

## User Experience

Users can enable offline mode in three ways:

- `--offline-mode`
- `PI_AGENT_OFFLINE_MODE=1`
- `/offline on`

Users can inspect or disable it with:

- `/offline status`
- `/offline off`

When offline mode is active, the extension shows one notification at session start:

```text
Offline mode enabled: local models only; web tools and wenchang disabled.
```

The extension also sets a footer/status item, defaulting to:

```text
offline: llama-swap
```

The extension does not repeat the notification on every turn. Blocked tools return a clear block reason, but no extra notification is required.

## Configuration

The extension reads optional JSON configuration from two places:

1. `~/.pi/agent/offline.json`
2. `<cwd>/.pi/offline.json`

Project config overrides global config. Missing fields use defaults.

Default config:

```json
{
  "enabled": false,
  "localProviders": ["llama-swap"],
  "defaultModel": "llama-swap/qwen3.6:27b",
  "agentModels": {
    "chengfeng": "llama-swap/qwen2.5-coder:7b",
    "guangguang": "llama-swap/qwen2.5-coder:7b",
    "jintong": "llama-swap/qwen3.6:27b",
    "kuafu": "llama-swap/qwen3.6:27b",
    "luban": "llama-swap/qwen3.6:27b",
    "houtu": "llama-swap/qwen3.6:27b",
    "fuxi": "llama-swap/gemma4:31b",
    "taishang": "llama-swap/gemma4:31b",
    "direnjie": "llama-swap/gemma4:26b",
    "yanluo": "llama-swap/gemma4:26b",
    "weizheng": "llama-swap/gemma4:26b",
    "yunu": "llama-swap/gemma4:31b"
  },
  "blockedAgents": ["wenchang"],
  "blockedTools": ["web_search", "code_search", "fetch_content", "get_search_content"],
  "notifyOnSessionStart": true,
  "statusText": "offline: llama-swap"
}
```

The local model list matches the current `~/.pi/agent/models.json` provider:

- `llama-swap/qwen3.6:27b`
- `llama-swap/gemma4:31b`
- `llama-swap/gemma4:26b`
- `llama-swap/qwen2.5-coder:14b`
- `llama-swap/qwen2.5-coder:7b`
- `llama-swap/gemma4:e4b`

## Architecture

Create a new directory extension:

```text
extensions/offline/
├── README.md
├── index.ts
└── offline.test.ts
```

Keep the implementation small. A single `index.ts` can own config loading, runtime state, guards, and commands.

### Activation State

Offline mode is active if any of these is true:

- `--offline-mode` flag is set.
- `PI_AGENT_OFFLINE_MODE=1` is set.
- `offline.json` has `enabled: true`.
- The user runs `/offline on` in the current session.

`/offline off` disables it for the current session even if config enabled it. The command does not write files.

### Model Guard

When offline mode is active, the extension forces the parent session to a local model. It resolves `defaultModel` through `ctx.modelRegistry.find()` / model matching and calls `pi.setModel()` on `session_start` and `before_agent_start` if the current provider is not in `localProviders`.

The extension also wraps `ctx.modelRegistry.getAvailable()` while active so it returns only models whose provider is in `localProviders`. This makes cloud models invisible to code paths that choose the first available model from a chain.

This wrapper is the only intentional pragmatic part of the design. Pi documents `ctx.modelRegistry`, but not monkey-patching its methods as a first-class policy hook. The wrapper should be defensive:

- Install once per runtime.
- Preserve the original method.
- Restore or bypass filtering when offline mode is disabled.
- Leave `getAll()` unchanged.

### Subagent Guard

Current subagent resolution gives agent frontmatter models priority over `Agent` tool params. Because of that, mutating `event.input.model` alone is not enough for per-agent offline routing.

On `tool_call` for `Agent`:

1. Read `event.input.subagent_type`.
2. If it matches `blockedAgents`, block the call.
3. Resolve `agentModels[subagent_type]` if present.
4. If a per-agent local model resolves, call `pi.setModel()` before the `Agent` tool executes. The subagent extension starts from `ctx.model`, then falls back to that parent model when frontmatter cloud candidates are hidden by the filtered registry.
5. Record the previous parent model for that tool call.
6. On `tool_result` for the matching `Agent` tool call, restore the previous parent model if offline mode is still active and the current model is the temporary per-agent model.

This gives one-extension per-agent routing without changing `extensions/subagent/` or agent frontmatter. The tradeoff is a brief parent-model switch around subagent creation. The UI may show that model change momentarily.

### Tool Guard

On `tool_call`, block any tool name in `blockedTools`.

Initial blocked tools:

- `web_search`
- `code_search`
- `fetch_content`
- `get_search_content`

Do not block shell commands in the first version. Shell network detection is heuristic and noisy. Users who need a hard guarantee should rely on actual network absence, OS firewall rules, or container networking.

### System Prompt Injection

On `before_agent_start`, append offline instructions to the system prompt when offline mode is active:

```text
Offline mode is ON.

Constraints:
- Assume no internet access.
- Use only local files, local tools, and local models.
- Do not delegate to wenchang.
- Do not call web, search, or fetch tools.
- Do not suggest online documentation unless the user asks to leave offline mode.
- If external information is missing, state what local evidence is missing and proceed from repo files, local docs, and cached context.
```

This is a behavior nudge, not the enforcement layer. Tool and model guards enforce the important constraints.

### UI

On `session_start`, if offline mode is active:

- Call `ctx.ui.notify(...)` once if `notifyOnSessionStart` is true.
- Call `ctx.ui.setStatus("offline", config.statusText)`.

When offline mode is disabled, clear or replace the status.

## Data Flow

1. Pi loads the extension.
2. Extension registers flag, command, and event handlers.
3. `session_start` loads config, resolves activation state, filters model availability, forces local model, and shows notification/status.
4. User prompt triggers `before_agent_start`.
5. Extension rechecks activation state, forces local model if needed, and injects offline instructions.
6. If the model calls tools, `tool_call` blocks web tools and `wenchang`.
7. For allowed subagents, `tool_call` temporarily switches the parent model to the configured local model for that subagent.
8. Subagent model resolution sees only local available models because of the filtered registry; cloud frontmatter entries fail and the subagent falls back to the temporary parent model.
9. `tool_result` restores the previous parent model after subagent creation/execution.

## Error Handling

- Invalid JSON: show one error notification and fall back to defaults.
- Missing configured model: show one error notification and keep the current model if no local fallback resolves.
- `pi.setModel()` returns false: show one error notification explaining the local model is unavailable.
- Unknown subagent type: leave `event.input.model` unchanged unless blocked.
- Disabled offline mode: all guards no-op.

## Testing

Unit tests should cover:

- Config merge order: defaults < global < project.
- Activation precedence: command off overrides config/flag for current session.
- `getAvailable()` filtering keeps only local providers while active.
- Parent model is forced when current model is cloud.
- `before_agent_start` injects offline instructions only when active.
- Web tools are blocked.
- `Agent` with `wenchang` is blocked.
- `Agent` with `jintong` temporarily switches the parent model to `agentModels.jintong`.
- `tool_result` restores the previous parent model after the `Agent` call.
- Notification fires once on session start, not every turn.

Smoke coverage should ensure `extensions/offline/index.ts` loads with the root extension smoke harness.

## Open Questions

None for the first version.
