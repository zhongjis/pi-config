# openai-fast

Enables OpenAI Codex Fast mode for ChatGPT-auth GPT-5.4 and GPT-5.5 by injecting OpenAI's priority service tier into eligible provider requests.

## Upstream

- **Source:** https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/openai-fast
- **Version:** `@diegopetrucci/pi-openai-fast` v0.1.4
- **Last synced commit:** `384a6aca78dd5e08d607c8b434f04406c478c155`
- **License:** MIT; copyright (c) 2026 Diego Petrucci
- **Adapted:** Runtime `index.ts` copied verbatim; README rewritten for this repo's vendored-extension format. Upstream package metadata, example config, and fleet test marker are not copied because this repo loads extensions directly.

## Commands

- `/fast` — Toggle OpenAI Fast mode on or off for the current session/runtime.

## Hooks

- `session_start` — Load global/project config and initialize per-session state.
- `model_select` — Refresh footer status when model changes.
- `before_provider_request` — Inject `service_tier: "priority"` into eligible OpenAI Codex request payloads.

## Settings / Configuration

Config is optional. Project config overrides global config.

- Global config: `~/.pi/agent/extensions/openai-fast.json`
- Project config: `.pi/openai-fast.json`

Fields:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `false` | Default Fast-mode state when no session override exists. |
| `showStatus` | `boolean` | `true` | Show `fast` in the footer while active for an eligible model. |

## Behavior

Fast mode is injected only when all conditions match:

- Provider is `openai-codex`.
- API is `openai-codex-responses`.
- Model is `gpt-5.4` or `gpt-5.5`.
- Provider uses ChatGPT OAuth/subscription auth, not API-key auth.
- Request payload does not already include `service_tier`.

When eligible and enabled, outbound payloads receive `service_tier: "priority"`.
