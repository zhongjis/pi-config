# Clauderock extension

Maintain this extension as a Claude→Bedrock routing controller for Anthropic-provider sessions. Current entrypoint: `extensions/clauderock/index.ts`.

## File layout target
Refactor toward this module map and keep responsibilities narrow:

- `routing-state.ts` — authoritative derived routing/session state
- `model-mapping.ts` — Anthropic↔Bedrock ID mapping and normalization
- `error-detection.ts` — quota / rate-limit detection helpers
- `cache.ts` — `clauderock-state.json` read/write/compat behavior
- `aws.ts` — AWS profile and credential helpers
- `stream-routing.ts` — pre-content fallback decision and Bedrock stream handoff
- `status-presentation.ts` — routing labels, status bar text, notifications, shared copy
- `health-check.ts` — Claude API and AWS/Bedrock probes
- `commands.ts` — `/clauderock` command registration and dispatch
- `index.ts` — wiring only

## Invariants
- Derived routing state is authoritative.
- Do not mutate routing globals directly outside the controller/state layer.
- Do not let Bedrock model IDs leak into pi state; rewrite them back to Anthropic IDs before pi sees them.
- Fallback may occur only before any response content has been emitted.
- Preserve compatibility with legacy `clauderock-state.json` cache contents.

## Presentation rules
- Keep user-facing copy centralized in status/notification/command-formatting code.
- Do not embed status text or notification wording inside stream-routing logic.
- Status bar, `/clauderock status`, `/clauderock health`, and notifications must share the same routing labels.

## Verification
- First check changed files with `lsp_diagnostics`.
- Only do runtime smoke testing if the user explicitly approves loading this repo into the active `~/.pi/agent` config.

## Gotchas
- If fallback is armed and the selected Anthropic model has no Bedrock mapping, present it as unavailable; do not imply fallback can serve it.
- Preserve the distinction between direct Claude routing and Clauderock fallback without duplicating label logic.
