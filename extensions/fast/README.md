# fast

Enables provider Fast mode for the active model with a single `/fast` toggle. Detects the current model's provider and applies the matching mechanism:

- **OpenAI Codex** (`gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`): injects `service_tier: "priority"` with OAuth/subscription auth. [1]
- **CLIProxyAPI** (the same exact GPT IDs, provider `cliproxyapi`, API `openai-responses`): injects `service_tier: "priority"` with Pi local API-key auth; CLIProxyAPI handles downstream Codex auth. [2] [3]
- **Anthropic Claude Opus** (`claude-opus-4-8`, `claude-opus-5`): injects `speed: "fast"` and the required `anthropic-beta` header. [4]

Exact IDs only; no aliases or wildcard matching. The internal `codex-auto-review` model is excluded.

Sources:
- [1] [Official Codex model catalog](https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json)
- [2] [CLIProxyAPI Codex Responses translator](https://github.com/router-for-me/CLIProxyAPI/blob/673131f57484517c3a1eae7e36c4cfa7b9bb4efc/internal/translator/codex/openai/responses/codex_openai-responses_request.go)
- [3] [CLIProxyAPI translator tests](https://github.com/router-for-me/CLIProxyAPI/blob/673131f57484517c3a1eae7e36c4cfa7b9bb4efc/internal/translator/codex/openai/responses/codex_openai-responses_request_test.go)
- [4] [Anthropic Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode.md)

## Upstream

Merged locally from two separate upstream extensions by Diego Petrucci (MIT, copyright (c) 2026 Diego Petrucci):

- **openai-fast:** https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/openai-fast — `@diegopetrucci/pi-openai-fast` v0.1.4
- **claude-fast:** https://github.com/diegopetrucci/pi-extensions/tree/main/extensions/claude-fast — `@diegopetrucci/pi-claude-fast` v0.1.2
- **Last synced commit:** `384a6aca78dd5e08d607c8b434f04406c478c155`

Because the two upstream packages are merged into one local extension behind a profile registry, future upstream syncs must be applied per-profile by hand (see `AGENTS.md`).

## Commands

- `/fast` — Toggle Fast mode on or off for the current session. Bare toggle only; any argument prints usage.

## Hooks

- `session_start`, `model_select` — Refresh footer from branch-local policy.
- `before_provider_request` — Apply the provider-specific Fast field.
- `before_provider_headers` — Merge/mask request-local beta headers, never mutate shared model headers.
- `fast:policy-changed` — Session-ID-scoped UI refresh only; request policy always reads the current branch.

## Settings / Configuration

No config files. `fast-policy` custom entries persist the session's mode default or `/fast` override across reload and branch navigation. Standalone sessions default off. See [mode defaults](../modes/README.md#fast-defaults) for transition rules.

## Behavior

Interactive `/fast` activation requires all conditions below (unsupported models remain enabled-but-inactive):

- The active model's provider has a Fast profile (`openai-codex`, `cliproxyapi`, or `anthropic`).
- The model's API matches the profile (`openai-codex-responses`, `openai-responses`, or `anthropic-messages`).
- The model is one of the supported models listed above.
- OpenAI Codex requires OAuth/subscription auth; CLIProxyAPI accepts Pi local API-key auth because the proxy handles downstream Codex auth.
- The request payload does not already include the injected field.

When enabled and eligible, the footer shows `fast` and outbound payloads receive the provider-specific field. When enabled but the active model is ineligible, no footer is shown and `/fast` reports why. For Anthropic OAuth models, the `anthropic-beta` header retains the required Claude Code OAuth beta values alongside `fast-mode-2026-02-01`.

CLIProxyAPI's verified core translator preserves `service_tier: "priority"` (and normalizes `"fast"` to `"priority"`), but it may only forward that tier: upstream scheduling is not guaranteed. [2] [3]

[Shared helpers](../lib/README.md#fast-request-helpers) define strict request mechanics; [subagents](../subagents/AGENTS.md) own fixed child policy.
