# extensions/lib

Shared utilities for pi extensions. Import via `../lib/index.js`.

## Modules

| File | What |
|------|------|
| `active-tools.ts` | Shared active-tool allowlist policy for built-ins and extension tools |
| `agent-frontmatter.ts` | Shared agent/mode frontmatter parser (`builtin_tools`, `extension_tools`, delegation, model) |
| `model-selection.ts` | Parse and resolve model spec strings (`provider/model:level:fast,fallback`); selected candidate alone carries optional `fast` metadata |
| `fast.ts` | `getFastProfile`, `getFastEligibility`, `transformFastPayload`, `transformFastHeaders` — stateless Codex/Anthropic request recipes |
| `thinking-level.ts` | `ThinkingLevel` type, validation, normalization |
| `clipboard.ts` | System clipboard read/write |
| `logger.ts` | Debug logging with `--debug` flag support |
| `status.ts` | Status bar helpers |
| `utils.ts` | `debounce`, `checkExec`, `notifyError`, `computeLineDiff` |
| `ux.ts` | UX helpers |
| `provider-errors.ts` | `getErrorText`, `isQuotaError` (402 + billing/credit/quota/spend), `isRateLimitError` (429 + rate-limit keywords), `isQuotaOrRateLimitError` |
| `fallback-cache.ts` | `createFlatFallbackCache(filename)` + `createKeyedFallbackCache(filename)` — cross-session fallback state with optional TTL |
| `notify-once.ts` | `createOnceNotifier()` — defer notifications from stream-wrapping code until a safe UI moment (e.g., `turn_end`) |
| `stream-fallback.ts` | `streamWithFallback(opts)` — generic two-tier failover wrapper; `patchEventModelId(event, id)` — rewrite model fields on emitted events |

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
- No extension-specific state — pure functions and types only.
- Re-export everything through `index.ts`.

## Fast request helpers

- `FastModel` takes `provider`, `api`, `id`, and optional readonly model headers; `getFastEligibility(model, usingOAuth)` returns `eligible`, `modelKey`, and an optional reason.
- Both transforms take `(input, model, policy)` with `FastPolicy` `{ enabled, usingOAuth, strict? }`. Payload input is unknown; header input is a native string/null record or undefined.
- `transformFastPayload` returns a replacement or undefined for no change. Default interactive policy preserves existing fields; strict on overwrites conflicts, strict off removes only the provider's exact fast value (including unsupported IDs on the matching API). Payload model identity must match.
- `transformFastHeaders` merges model and request headers into a fresh record, unions Anthropic beta tokens, adds OAuth base betas when active, and removes only the fast beta when inactive. Every observed casing is masked with the resulting value (including empty strings); assign the result to native `event.headers`, never to shared `model.headers`.
- Profiles exactly cover OAuth Codex `gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra` [1] and Anthropic `claude-opus-4-8`, `claude-opus-5` [2]. No aliases, wildcards, internal `codex-auto-review`, or other provider expansion. Runtime policy belongs to [modes](../modes/AGENTS.md) and [subagents](../subagents/AGENTS.md).
- `assertFastSupported` validates the selected explicit-on candidate before application. Strict transforms assume that validation and bypass later OAuth eligibility drift; they never silently downgrade. Provider/API/model recipes remain unchanged.
- `readFastPolicy` reads typed `fast-policy` custom entries from a supplied session branch: `{ version: 1, mode, source: "mode" | "user", enabled }`. It stores no state. Empty mode names denote standalone interactive `/fast`.

Sources:
- [1] [Official Codex model catalog](https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json)
- [2] [Anthropic Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode.md)
