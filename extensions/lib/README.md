# extensions/lib

Shared utilities for pi extensions. Import via `../lib/index.js`.

## Modules

Flat utility modules for model selection, fallback, fast requests, logging, clipboard, status, and tool output. [index.ts](index.ts) re-exports the public set.

## Usage

```ts
import { initLib } from "../lib/index.js";
import { parseModelChain, resolveFirstAvailable } from "../lib/index.js";

export default function myExtension(pi: ExtensionAPI) {
  initLib(pi);  // wire debug logging (idempotent)

  // Parse "anthropic/claude-opus-4-7:high,openai/gpt-5:medium"
  const candidates = parseModelChain(modelStr);
  // → [{ model: "anthropic/claude-opus-4-7", thinkingLevel: "high" }, ...]

  const resolved = resolveFirstAvailable(candidates, ctx.modelRegistry);
  if (resolved) {
    await pi.setModel(resolved.model);
    if (resolved.thinkingLevel) pi.setThinkingLevel(resolved.thinkingLevel);
  }
}
```

## Conventions

- Flat files, no subdirectories (until lib grows large enough to warrant them).
- Callers own extension-specific policy; shared coordinators retain only their per-session recovery state.
- Re-export everything through `index.ts`.

## Fast request helpers

- `FastModel` takes `provider`, `api`, `id`, and optional readonly model headers; `getFastEligibility(model, usingOAuth)` returns `eligible`, `modelKey`, and an optional reason.
- Both transforms take `(input, model, policy)` with `FastPolicy` `{ enabled, usingOAuth, strict? }`. Payload input is unknown; header input is a native string/null record or undefined.
- `transformFastPayload` returns a replacement or undefined for no change. Default interactive policy preserves existing fields; strict on overwrites conflicts, strict off removes only the provider's exact fast value (including unsupported IDs on the matching API). Payload model identity must match.
- `transformFastHeaders` merges model and request headers into a fresh record, unions Anthropic beta tokens, adds OAuth base betas when active, and removes only the fast beta when inactive. Every observed casing is masked with the resulting value (including empty strings); assign the result to native `event.headers`, never to shared `model.headers`.
- Profiles exactly cover OAuth Codex and local-API-key CLIProxyAPI (`cliproxyapi` / `openai-responses` or `openai-codex-responses`) `gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol` [1] [2], and Anthropic `claude-opus-4-8`, `claude-opus-5` [4]. No aliases, wildcards, internal `codex-auto-review`, or other provider expansion. Runtime policy belongs to [modes](../modes/AGENTS.md) and [subagents](../subagents/AGENTS.md).
- CLIProxyAPI's core translator preserves `service_tier: "priority"` (and normalizes `"fast"` to `"priority"`); proxy forwarding does not guarantee upstream scheduling. [2] [3]
- `assertFastSupported` validates the selected explicit-on candidate before application. Strict transforms assume that validation and bypass later OAuth eligibility drift; they never silently downgrade. Provider/API/model recipes remain unchanged.
- `readFastPolicy(branch, entries)` resolves typed `fast-policy` custom entries: `{ version: 1, mode, source: "mode" | "user", enabled }`. The latest user entry in full session `entries` wins, including off; without one, the latest mode default in `branch` applies. The second argument defaults to `branch`. It stores no state. Empty mode names denote standalone interactive `/fast`.

Sources:
- [1] [Official Codex model catalog](https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json)
- [2] [CLIProxyAPI Codex Responses translator](https://github.com/router-for-me/CLIProxyAPI/blob/673131f57484517c3a1eae7e36c4cfa7b9bb4efc/internal/translator/codex/openai/responses/codex_openai-responses_request.go)
- [3] [CLIProxyAPI translator tests](https://github.com/router-for-me/CLIProxyAPI/blob/673131f57484517c3a1eae7e36c4cfa7b9bb4efc/internal/translator/codex/openai/responses/codex_openai-responses_request_test.go)
- [4] [Anthropic Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode.md)
