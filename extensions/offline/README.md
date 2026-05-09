# offline

Offline-mode guard for Pi sessions: local models only, web tools blocked, wenchang blocked.

## Features

- Enables offline mode from `--offline-mode`, `PI_AGENT_OFFLINE_MODE=1`, config, or `/offline on`.
- Forces the parent session onto a configured local model when active.
- Filters `ctx.modelRegistry.getAvailable()` so only configured local providers are visible while active.
- Blocks web-dependent tools and delegation to `wenchang`.
- Temporarily switches the parent model around `Agent` calls for per-agent local routing, then restores it.
- Injects an offline system instruction and shows a persistent `offline` status item.

## Commands

- `/offline on` — Enable offline mode for the current session.
- `/offline off` — Disable offline mode for the current session, overriding config/flag/env until reload.
- `/offline status` — Show whether offline mode is active.

## Hooks

- `session_start` — Loads config, installs model filtering, forces a local model, shows one notification, sets status.
- `before_agent_start` — Re-applies local model guard and appends offline instructions.
- `tool_call` — Blocks configured tools/agents and applies temporary per-agent local model routing.
- `tool_result` — Restores the parent model after temporary `Agent` routing.

## Configuration

Config files are optional JSON. Project config overrides global config.

- Global: `~/.pi/agent/offline.json`
- Project: `<cwd>/.pi/offline.json`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable offline mode from config. |
| `localProviders` | `string[]` | `["llama-swap"]` | Providers considered local. |
| `defaultModel` | `string` | `"llama-swap/qwen3.6:27b"` | Parent model used when current model is not local. |
| `agentModels` | `object` | built-in agent map | Per-agent local model routing for `Agent` calls. |
| `blockedAgents` | `string[]` | `["wenchang"]` | Subagents blocked while offline. |
| `blockedTools` | `string[]` | web/search/fetch tools | Tools blocked while offline. |
| `notifyOnSessionStart` | `boolean` | `true` | Show the session-start notification. |
| `statusText` | `string` | `"offline: llama-swap"` | Persistent footer/status text. |

Example:

```json
{
  "enabled": true,
  "defaultModel": "llama-swap/qwen3.6:27b",
  "agentModels": {
    "jintong": "llama-swap/qwen3.6:27b",
    "chengfeng": "llama-swap/qwen2.5-coder:7b"
  }
}
```
