# offline

Offline-mode guard for Pi sessions: local models only, web tools blocked, wenchang blocked.

## Features

- Enables offline mode only with `/offline on` in the current session.
- Persists activation through reloads of that same session via a session custom entry.
- Forces the parent session onto a configured local model when active.
- Filters `ctx.modelRegistry.getAvailable()` so only configured local providers are visible while active.
- Lets subagent frontmatter fallback choose local models from the filtered registry.
- Blocks web-dependent tools and delegation to `wenchang`.
- Injects an offline system instruction and shows a persistent `offline` status item.

## Commands

- `/offline on` — Enable offline mode for the current session and persist it in this session log.
- `/offline off` — Disable offline mode for the current session and persist that state in this session log.
- `/offline status` — Show whether offline mode is active.

## Hooks

- `session_start` — Loads project policy, restores session activation, installs model filtering, forces a local model, shows one notification, sets status.
- `before_agent_start` — Re-applies local model guard and appends offline instructions.
- `tool_call` — Blocks configured web tools and blocked agents.

## Policy

Activation is session-scoped. No config file can turn offline mode on.

Optional project policy lives at `<cwd>/.pi/offline.json`. The extension does not read `~/.pi/agent/offline.json`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `localProviders` | `string[]` | `["llama-swap"]` | Providers considered local. |
| `defaultModel` | `string` | `"llama-swap/qwen2.5-coder:14b"` | Parent model used when current model is not local. |
| `blockedAgents` | `string[]` | `["wenchang"]` | Subagents blocked while offline. |
| `blockedTools` | `string[]` | web/search/fetch tools | Tools blocked while offline. |
| `notifyOnSessionStart` | `boolean` | `true` | Show the session-start notification. |
| `statusText` | `string` | `"offline: llama-swap"` | Persistent footer/status text. |

Unsupported legacy keys are ignored:

- `enabled`
- `agentModels`

Example:

```json
{
  "defaultModel": "llama-swap/qwen2.5-coder:14b",
  "blockedAgents": ["wenchang"],
  "statusText": "offline: llama-swap"
}
```
