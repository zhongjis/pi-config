# profiles

Provider-scope profiles for pi. Switches the active set of model providers between `default` (US — Anthropic, OpenAI), `opencode` (China — OpenCode Zen + Go), and `local` (offline-capable — llama-swap).

## What it does

- Filters `registry.getAvailable()` to a profile-specific allowlist so `/model`, subagent model resolution, and the frontmatter fallback chain only see providers that belong to the active profile.
- Force-switches the current session's model when activating a profile if the current model isn't in the allowlist.
- Persists profile choice in the session journal (`panda:profile` custom entry) so `--resume` + `--continue` restore it.
- Honors `PI_PROFILE=<name>` env var as the default when no session state exists — lets nix-config set the profile per machine/location.
- Shows `● profile: <name>` status bar indicator when a non-default profile is active.
- **The `local` profile includes offline guards:** blocks web tools, blocks `wenchang` delegation, and injects an offline system prompt.

## Profiles

| Profile | Providers kept | Intended use |
|---|---|---|
| `default` | `anthropic`, `openai-codex`, `openai`, `amazon-bedrock`, `google` | US default — paid frontier models. |
| `opencode` | `opencode-go`, `opencode` | China — OpenCode Go subscription, Zen overflow. |
| `local` | `llama-swap` | Offline-first or no-network environments. Blocks web tools and wenchang. |

Override via `.pi/profiles.json` (project) or `~/.pi/agent/profiles.json` (global). Project overrides global.

## Commands

- `/profile` or `/profile status` — Show active profile.
- `/profile <name>` — Switch to a named profile (works for any configured profile).
- `/profile:default`, `/profile:opencode`, `/profile:local` — Shortcut commands for built-in profiles.

Shortcut commands (`/profile:<name>`) are only auto-registered for built-in profiles (`default`, `opencode`, `local`). Custom profiles defined only in config files use `/profile <name>` instead — command registration happens at extension load, before config is read.

## CLI flag

`pi --profile <name>` activates a profile for the session. Example:

```bash
pi --profile opencode
pi --profile local "summarize this file"
```

The CLI choice is persisted into session state, so `pi --resume` keeps the profile without needing the flag again.

## Activation order

When a session starts, the active profile is determined by the first match:

1. `--profile <name>` CLI flag (explicit, one-shot override — wins over everything).
2. `panda:profile` custom entry in the session journal (from a previous `/profile <name>` or `--profile`).
3. `PI_PROFILE` environment variable.
4. Config `defaultProfile` (either global or project `profiles.json`).
5. Hardcoded default: `default`.

## Configuration

Global: `~/.pi/agent/profiles.json`
Project: `<cwd>/.pi/profiles.json`

```json
{
  "defaultProfile": "opencode",
  "profiles": {
    "default": {
      "providers": ["anthropic", "openai-codex"],
      "defaultModel": "anthropic/claude-opus-4-7",
      "statusText": "default"
    },
    "opencode": {
      "providers": ["opencode-go", "opencode"],
      "defaultModel": "opencode-go/kimi-k2.6",
      "statusText": "opencode"
    },
    "local": {
      "providers": ["llama-swap"],
      "defaultModel": "llama-swap/qwen2.5-coder:14b",
      "statusText": "local",
      "blockedAgents": ["wenchang"],
      "blockedTools": ["web_search", "code_search", "fetch_content", "get_search_content"],
      "systemPrompt": "Offline mode is ON.\n\nConstraints:\n- Assume no internet access.\n...",
      "notifyOnSessionStart": true
    }
  }
}
```

All fields are optional — omit to inherit the built-in defaults.

### Profile config fields

| Key | Type | Description |
|-----|------|-------------|
| `providers` | `string[]` | Allowed model providers. |
| `defaultModel` | `string` | Model to force-switch to when current model is out-of-profile. |
| `statusText` | `string` | Status bar indicator text. |
| `blockedAgents` | `string[]` | Subagents to block while this profile is active. |
| `blockedTools` | `string[]` | Tools to block while this profile is active. |
| `systemPrompt` | `string` | Extra system prompt injected while this profile is active. |
| `notifyOnSessionStart` | `boolean` | Show a notification when this profile activates on session start. |

## Frontmatter compatibility

Agent frontmatter uses a single comma-separated `model:` chain covering all profiles:

```yaml
model: gpt-5.4-mini, claude-haiku-4-5, opencode-go/qwen3.5-plus, llama-swap/qwen2.5-coder:7b
```

pi's `resolveModel` walks the chain and returns the first entry whose provider is in the active profile's allowlist. See [`docs/opencode-agent-models.md`](../../docs/opencode-agent-models.md) for the opencode-profile mapping.
