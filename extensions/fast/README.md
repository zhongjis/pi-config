# fast

Enables provider Fast mode for the active model with a single `/fast` toggle. Detects the current model's provider and applies the matching mechanism:

- **OpenAI Codex** (`gpt-5.4`, `gpt-5.5`): injects `service_tier: "priority"`.
- **Anthropic Claude Opus** (`claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`): injects `speed: "fast"` and the required `anthropic-beta` header.

## Upstream

Merged locally from two separate upstream extensions by Diego Petrucci (MIT, copyright (c) 2026 Diego Petrucci):

- **openai-fast:** https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/openai-fast — `@diegopetrucci/pi-openai-fast` v0.1.4
- **claude-fast:** https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/claude-fast — `@diegopetrucci/pi-claude-fast` v0.1.2
- **Last synced commit:** `384a6aca78dd5e08d607c8b434f04406c478c155`

Because the two upstream packages are merged into one local extension behind a profile registry, future upstream syncs must be applied per-profile by hand (see `AGENTS.md`).

## Commands

- `/fast` — Toggle Fast mode on or off for the current session. Bare toggle only; any argument prints usage.

## Hooks

- `session_start` — Initialize per-session state (Fast off by default).
- `model_select` — Refresh footer status and sync the active model's beta header when the model changes.
- `before_provider_request` — Inject the provider-specific Fast field into eligible request payloads.

## Settings / Configuration

None. State is session-only: `/fast` toggles Fast mode for the current session, and the toggle persists until the session ends. There are no config files.

## Behavior

Fast mode is applied only when all conditions match:

- The active model's provider has a Fast profile (`openai-codex` or `anthropic`).
- The model's API matches the profile (`openai-codex-responses` / `anthropic-messages`).
- The model is one of the supported models listed above.
- For OpenAI Codex, the provider uses OAuth/subscription auth (not API-key auth).
- The request payload does not already include the injected field.

When enabled and eligible, the footer shows `fast` and outbound payloads receive the provider-specific field. When enabled but the active model is ineligible, no footer is shown and `/fast` reports why. For Anthropic OAuth models, the `anthropic-beta` header retains the required Claude Code OAuth beta values alongside `fast-mode-2026-02-01`.
