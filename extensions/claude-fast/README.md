# claude-fast

Enables Anthropic Claude Fast mode for supported Claude Opus models by injecting `speed: "fast"` and the required Anthropic beta header into eligible provider requests.

## Upstream

- **Source:** https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/claude-fast
- **Version:** `@diegopetrucci/pi-claude-fast` v0.1.2
- **Last synced commit:** `384a6aca78dd5e08d607c8b434f04406c478c155`
- **License:** MIT; copyright (c) 2026 Diego Petrucci
- **Adapted:** Runtime `index.ts` copied verbatim; README rewritten for this repo's vendored-extension format. Upstream package metadata, example config, and fleet test marker are not copied because this repo loads extensions directly.

## Commands

- `/claude-fast` — Toggle Claude Fast mode on or off for the current session/runtime.

## Hooks

- `session_start` — Load global/project config and initialize per-session state.
- `model_select` — Refresh footer status and sync model beta headers when model changes.
- `before_provider_request` — Inject `speed: "fast"` into eligible Anthropic request payloads.

## Settings / Configuration

Config is optional. Project config overrides global config.

- Global config: `~/.pi/agent/extensions/claude-fast.json`
- Project config: `.pi/claude-fast.json`

Fields:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `false` | Default Fast-mode state when no session override exists. |
| `showStatus` | `boolean` | `true` | Show `fast` in the footer while active for an eligible model. |

## Behavior

Fast mode is injected only when all conditions match:

- Provider is `anthropic`.
- API is `anthropic-messages`.
- Model is `claude-opus-4-6`, `claude-opus-4-7`, or `claude-opus-4-8`.
- Request payload does not already include `speed`.

When eligible and enabled, outbound payloads receive `speed: "fast"`. The current model's `anthropic-beta` header also includes `fast-mode-2026-02-01`; OAuth models retain required Claude Code OAuth beta values.
