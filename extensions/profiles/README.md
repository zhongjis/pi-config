# profiles

Provider-scope profiles for pi. Switches the active set of model providers between `default` (US — Anthropic, OpenAI), `opencode` (China — OpenCode Go), and `local` (offline-capable — llama-swap).

## What it does

- Filters `registry.getAvailable()` to a profile-specific allowlist so `/model`, subagent model resolution, and the frontmatter fallback chain only see providers that belong to the active profile.
- Force-switches the current session's model when activating a profile if the current model isn't in the allowlist.
- Persists profile choice in the session journal (`panda:profile` custom entry) so `--resume` + `--continue` restore it.
- Honors `PI_PROFILE=<name>` env var as the default when no session state exists — lets nix-config set the profile per machine/location.
- Shows `● profile: <name>` status bar indicator when a non-default profile is active.
- **The `local` profile includes offline guards:** blocks external research tools, blocks `wenchang` delegation, and injects an offline system prompt.

## Profiles

`default` keeps the paid frontier providers, `opencode` keeps OpenCode Go, and `local` keeps llama-swap and blocks external research and MCP tools (`blockedTools` entries are names or `*` globs) and wenchang. `DEFAULT_PROFILES_CONFIG` in [index.ts](index.ts) defines each profile's providers, default model, status text, blocked agents and tools, and system prompt.

Profiles are hardcoded. No config files.

## Entry Points

- `/profile [status|<name>]` — show or switch the active profile. [index.ts](index.ts) registers this and the per-profile shortcut commands.

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
4. Hardcoded default: `default`.

## Frontmatter compatibility

Agent frontmatter uses a single comma-separated `model:` chain covering all profiles:

```yaml
model: gpt-5.4-mini, claude-haiku-4-5, opencode-go/qwen3.5-plus, llama-swap/qwen2.5-coder:7b
```

pi's `resolveModel` walks the chain and returns the first entry whose provider is in the active profile's allowlist. Model assignments are defined in agent frontmatter.
