# Hardcoded Models — Extension Audit

Every place in `extensions/` where a model id, model chain, or model-selection list is hardcoded. Catalogs intent, profile-awareness, and what changes when profiles switch.

Companion to:
- [`opencode-agent-models.md`](./opencode-agent-models.md) — per-agent model assignment under the `opencode` profile
- [`../extensions/profiles/README.md`](../extensions/profiles/README.md) — profile mechanism (registry filter + custom session entry)

Last audited: 2026-05-11. Refresh when adding new extensions that make LLM calls or read model state.

> **Note:** `web-access` is now the external `pi-web-access` git package (pinned in `settings.json`), not a local `extensions/` dir. Its rows below name upstream files; line numbers are dropped because they drift with the pinned version.

---

## Audit categories

| Category | Profile-aware? | Notes |
|---|---|---|
| **A. Profile-aware chains** | ✓ Yes | Walk a hardcoded list against `registry.getAvailable()` which profile filters |
| **B. Profile-bypassing chains** | ✗ No | Test auth directly, ignore `getAvailable()` — known gap |
| **C. External API integrations** | n/a | Use a non-pi API (Google, etc.) — profile-independent by design |
| **D. Provider-specific routing** | n/a | Activate only under one provider; profile-neutral |
| **E. Static identifiers** | n/a | Health probes, ID translation tables; not LLM-of-choice flows |

---

## Inventory

### A. Profile-aware chains (extend per profile)

These walk `getAvailable()` which is already filtered by the active profile. Adding entries per profile to the list is enough — no other code change needed.

| Extension | Where | Constant | Default profile | Opencode profile | Local profile |
|---|---|---|---|---|---|
| `boomerang` | [`commit.ts`](../extensions/boomerang/commit.ts) | `COMMIT_MODEL_CHAIN` | `gpt-5.4-mini`, `claude-haiku-4-5` | `opencode-go/qwen3.5-plus` | `llama-swap/qwen2.5-coder:7b` |
| `smart-sessions` | [`index.ts`](../extensions/smart-sessions/index.ts) | `AUTO_DETECT_MODELS` | `gpt-5.4-mini`, `gemini-3-flash`, `claude-haiku-4-5` | `qwen3.5-plus` | `qwen2.5-coder:14b` |
| `subagent` | [`src/default-agents.ts`](../extensions/subagent/src/default-agents.ts) | `general-purpose` agent default | `anthropic/claude-haiku-4-5-20251001` | — (no profile equivalent yet) | — |

**Pattern:** List one bare id (e.g., `qwen3.5-plus`) or `provider/id` (e.g., `opencode-go/qwen3.5-plus`) per profile. `getAvailable()` filtering naturally selects the right one.

**Adding a new entry:** edit the constant, append profile-equivalent id. No test changes unless the test asserts the exact chain text.

---

### B. Profile-bypassing chains (known gap)

These predate profiles and test auth directly via `getApiKeyAndHeaders` against a hardcoded candidate list. **Under non-default profiles they may still hit anthropic/openai/google credentials if authed, bypassing the profile filter.** Fix: refactor to consult `getAvailable()` first.

| Extension | Where | Mechanism | Models hardcoded |
|---|---|---|---|
| `web-access` | `index.ts` `resolveFirstAvailableModel` | Iterates candidate list, tests `getApiKeyAndHeaders` per entry | `anthropic/claude-haiku-4-5`, `google/gemini-2.5-flash`, `openai/gpt-4.1-mini` |
| `web-access` | `summary-review.ts` `PREFERRED_SUMMARY_MODELS` | Same as above, for search-result summarization | `anthropic/claude-haiku-4-5`, `openai-codex/gpt-5.3-codex-spark` |

**Why not fixed:** user-deferred. These features (web search summarization, query rewriting) are tightly bound to summary-quality experiments; opencode-go equivalents not yet validated.

**Action when ready:** route lookups through `ctx.modelRegistry.getAvailable()` and extend candidate list with `opencode-go/qwen3.6-plus`, `llama-swap/qwen2.5-coder:14b` (or equivalents).

---

### C. External API integrations (profile-independent by design)

These bypass pi's model registry entirely — they call Google's Gemini API or its web frontend directly. Profile cannot affect them because the feature is "Gemini-search-with-tools" or "Gemini-video-understanding", not "generic LLM call". Cannot be swapped for opencode-go because the capability doesn't exist there.

| Extension | Where | Constant | Purpose |
|---|---|---|---|
| `web-access` | `gemini-api.ts` | `DEFAULT_MODEL = "gemini-3-flash-preview"` | Default model for direct Gemini REST API calls |
| `web-access` | `gemini-search.ts` | inline `"gemini-3-flash-preview"` | Web search via Gemini |
| `web-access` | `gemini-url-context.ts` | inline `"gemini-3-flash-preview"` | URL content extraction via Gemini |
| `web-access` | `gemini-web.ts` | `MODEL_HEADERS` map | Gemini web product (Aistudio) cookie auth headers for `gemini-3-pro`, `gemini-2.5-pro`, `gemini-2.5-flash` |
| `web-access` | `video-extract.ts` | `preferredModel: "gemini-3-flash-preview"` | Video frame extraction + transcription |
| `web-access` | `youtube-extract.ts` | `preferredModel: "gemini-3-flash-preview"` | YouTube transcript via Gemini |
| `web-access` | `perplexity.ts` | `model: "sonar"` | Perplexity Sonar API |

**Requirement:** Google Gemini API key (`GEMINI_API_KEY`) or browser-Gemini cookies, regardless of profile. Perplexity needs `PERPLEXITY_API_KEY`.

---

### D. Provider-specific routing (profile-neutral)

Activates only under one provider. Other profiles ignore.

| Extension | Where | Models | Notes |
|---|---|---|---|
| `clauderock` | [`index.ts:25`](../extensions/clauderock/index.ts) | `ANTHROPIC_TO_BEDROCK` map: `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`, `claude-haiku-4-5-20251001` → Bedrock region-prefixed IDs | Only activates when current model provider is `anthropic`. Profile-neutral: opencode/local profiles never reach this code. |

---

### E. Static identifiers (not selection)

Fixed model IDs used as health probes, test fixtures, or example references. Not LLM-of-choice flows.

| Extension | Where | Model ID | Purpose |
|---|---|---|---|
| `clauderock` | `index.ts:695` | `us.anthropic.claude-opus-4-6-v1` | Bedrock connectivity test (`/clauderock test`) |
| `clauderock` | `index.ts:826` | `claude-haiku-4-5-20251001` | Anthropic API quota probe (`/clauderock health`) |

---

## Profile config

The `profiles` extension also encodes per-profile **default model** suggestions. These are the model picked when no scoped model resolves; they should be overridable per-user.

| Profile | Default model | File |
|---|---|---|
| `default` | `anthropic/claude-opus-4-7` | [`profiles/index.ts:62`](../extensions/profiles/index.ts) |
| `opencode` | `opencode-go/kimi-k2.6` | [`profiles/index.ts:67`](../extensions/profiles/index.ts) |
| `local` | `llama-swap/qwen2.5-coder:14b` | [`profiles/index.ts:72`](../extensions/profiles/index.ts) |

User override path: `~/.pi/profiles.json` (global) or `.pi/profiles.json` (project). Schema documented in [`profiles/README.md`](../extensions/profiles/README.md).

---

## Subagent / mode model defaults

Agent and mode model selection lives in frontmatter `model:` fields under `agents/` and `modes/` directories. **Not hardcoded in extension TS code.** See:

- [`opencode-agent-models.md`](./opencode-agent-models.md) — per-agent chain assignments
- Each `agents/*.md` and `modes/*.md` for the actual chains

Frontmatter chains use the same `parseModelChain` + `resolveFirstAvailable` mechanism as Category A above, so they pick up profile filtering automatically.

One exception: **`subagent/src/default-agents.ts`** hard-codes the default for the built-in `general-purpose` agent at `anthropic/claude-haiku-4-5-20251001`. Override per-project by creating a custom `general-purpose` agent in your `agents/` dir.

---

## When adding a new extension that calls an LLM

1. **Do NOT hardcode a single model.** Use `parseModelChain` + `resolveFirstAvailable` from `extensions/lib/model.js`.
2. **Include one entry per profile** in the chain — see Category A for examples.
3. **Walk `ctx.modelRegistry.getAvailable()`** (not `getAll()` and not raw auth checks) so profile filtering applies.
4. **Document the chain here** under Category A.
5. **If the feature is tied to one provider's specific capability** (e.g., Gemini search grounding), document it under Category C and explain why profile-independence is required.

---

## Refresh checklist

When new extensions land or profiles change:

```bash
# Find anything that mentions a specific model id
grep -rn "claude-\|gpt-\|gemini-\|qwen\|kimi-\|glm-\|minimax\|deepseek-\|mimo-" \
  extensions/ --include="*.ts" 2>/dev/null | grep -v test
```

Cross-check the output against this doc. New rows go under the appropriate category.
