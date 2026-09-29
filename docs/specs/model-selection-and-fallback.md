# Model Selection and Fallback

Status: shipped

How a model gets chosen, and what happens when the chosen one is unavailable.

This document describes the engine. Profiles, modes, subagents, and tool-model
roles feed it; one shared library does the parsing and matching. The companion
docs below build on this engine; read this first when the question is *how*
selection works, not *which* model a given agent or extension uses.

Companion docs:

- [`extension-model-usage.md`](./extension-model-usage.md) — `tool_models.json` roles for extension-owned LLM calls.
- [`../../extensions/profiles/README.md`](../../extensions/profiles/README.md) — profile commands, flags, and config fields.
- [`modes.md`](./modes.md) — mode switching and frontmatter.
Source is authoritative. Where a catalog doc disagrees with code, trust the code paths cited here.

---

## Selection surfaces

The shared library ([`model-selection.ts`](../../extensions/lib/model-selection.ts)) parses and resolves every spec. Profiles ([`profiles/index.ts`](../../extensions/profiles/index.ts)) decide which models are visible; modes ([`extensions/modes/src/`](../../extensions/modes/src/)) choose the main-session model; subagents ([`extensions/subagents/src/`](../../extensions/subagents/src/)) choose each agent's model; tool model roles ([`tool-models.ts`](../../extensions/lib/tool-models.ts), [`extension-model-usage.md`](./extension-model-usage.md)) choose models for extension-owned background calls. These surfaces compose; none replaces another.

The profile filter sits under everything: every `getAvailable()` call the other
surfaces make already returns a profile-filtered list.

Resolution fallback happens before a request. Runtime behavior is separate:
[`clauderock`](#runtime-provider-failover-clauderock) can switch an Anthropic
stream's provider, while the shared extension coordinator can continue a settled
quota/rate-limit/access-denied failure on the next configured model-chain candidate.

---

## Spec string format

A model spec is `provider/modelId:thinkingLevel`. The provider and thinking
level are optional. A comma joins specs into a chain.

```
gpt-5.4-mini, claude-haiku-4-5, opencode-go/qwen3.5-plus:high, llama-swap/qwen2.5-coder:7b
```

Two functions in [`model-selection.ts`](../../extensions/lib/model-selection.ts) parse this:

- **`parseModelPattern(segment)`** splits the trailing `:level` suffix when the
  suffix is a valid thinking level. It uses `lastIndexOf(":")`, so a model id
  that itself contains a colon (`qwen2.5-coder:7b`) keeps its colon unless the
  final segment names a thinking level.
- **`parseModelChain(input)`** splits on commas, trims, drops empty entries, and
  maps each to a candidate. The first candidate is primary; the rest are
  ordered fallbacks.

---

## Resolution engine

`resolveModel(input, registry)` turns one spec into a model instance, or returns
an error string. It reads from
`registry.getAvailable?.() ?? registry.getAll()`, so it sees only authed,
profile-allowed models.

Two strategies run in order:

1. **Exact `provider/modelId`** — matches only when the full id is in the
   available set. This is the safe path: it never resolves to an unavailable or
   wrong-provider model.
2. **Fuzzy score** — when no exact match applies, every available model gets a
   score and the best one wins if it reaches the minimum threshold. The scoring
   table lives in [`model-selection.ts`](../../extensions/lib/model-selection.ts).

Fuzzy matching is why a bare `qwen3.5-plus` is risky: when two providers both
register that id, the fuzzy pass may pick the wrong one. Prefix the provider
(`opencode-go/qwen3.5-plus`) to force the exact path.

**`resolveFirstAvailable(candidates, registry)`** walks a parsed chain and
returns the first candidate that resolves, with its thinking level
It returns `undefined` when
the whole chain fails. This is the core fallback primitive — every chain-aware
caller uses it.

**`resolveAllAvailable(candidates, registry)`** keeps every authenticated resolved
identity in chain order, preserving the first candidate's metadata. Runtime continuation
uses it to advance beyond the model that just failed; normal initial selection still
uses only `resolveFirstAvailable`.

---

## Profile filtering

A profile narrows the visible provider set.

**Registry patch.** `installModelRegistryFilter` wraps `registry.getAvailable`
once ([`profiles/index.ts`](../../extensions/profiles/index.ts)). When a
profile is active, the wrapped method filters the original result to the
profile's allowed providers. When no profile is active, it returns the original
list untouched. Every selection path that calls `getAvailable()` — the `/model`
picker, mode resolution, subagent resolution, and chain walks — inherits this
filter for free.

**Force-switch.** When a profile activates and the current session model sits
outside the allowlist, `forceProfileModel` moves the session onto a profile
model:

1. If the current model's provider is already allowed, do nothing.
2. Otherwise resolve the profile's `defaultModel` through `resolveModel`.
3. If that fails, take the first available model from an allowed provider.
4. If nothing is available, notify `Profiles: no model available for providers: …` and leave the model unchanged.

Built-in profiles, their allowed providers, default models, and profile-specific
restrictions are defined in [`profiles/index.ts`](../../extensions/profiles/index.ts)
and documented in the [profiles README](../../extensions/profiles/README.md).

**Activation precedence**, first match wins
([`profiles/index.ts`, `resolveInitialProfile`](../../extensions/profiles/index.ts)):

1. `--profile <name>` CLI flag.
2. `panda:profile` session-journal entry (from a prior `/profile` or `--profile`).
3. `PI_PROFILE` environment variable.
4. Hardcoded `default`.

---

## Subagent resolution

A subagent picks its model in strict priority order: explicit invocation param,
then agent-config chain, then the parent model
([`agent-runner.ts`](../../extensions/subagents/src/agent-runner.ts),
[`invocation-config.ts`](../../extensions/subagents/src/invocation-config.ts)).

`resolveAgentInvocationConfig` computes the raw model and records whether it came from the tool param.

The agent config wins over the tool param. The `modelFromParams` flag matters
only for how a *failed* chain behaves.

**When the chain fails, the origin decides the outcome**
([`index.ts`](../../extensions/subagents/src/index.ts)):

| Chain origin | All candidates fail | Result |
|---|---|---|
| Tool param (`modelFromParams`) | Return the first candidate's error string | Agent does not run |
| Agent config | Silent fallback to the parent model | Agent runs on parent model |

An explicit caller override gets a hard error so the mistake surfaces; a config
default degrades quietly so a missing model never blocks delegation.

**One extra config-chain fallback.** `resolveDefaultModel` adds a step beyond
`resolveFirstAvailable`
([`agent-runner.ts`](../../extensions/subagents/src/agent-runner.ts)): if the
chain resolves nothing through `getAvailable()`, it retries each
`provider/modelId` candidate against `registry.find()` directly, bypassing the
availability filter. Only then does it fall back to the parent model with a
`[subagent] Could not resolve any model … Falling back to parent model` warning.

Built-in agent-type model defaults live in [`agent-types.ts`](../../extensions/subagents/src/agent-types.ts).
User `.md` agents with the same name override these defaults. An unknown or
disabled agent type falls back to `general-purpose`.

---

## Mode resolution

A mode can pin the main session's model through its frontmatter `model:` field,
read from `~/.pi/agent/agents/<mode>.md`
([`config-loader.ts`](../../extensions/modes/src/config-loader.ts)). On mode switch,
`applyModelFromConfig` parses the chain, calls `resolveFirstAvailable`, and sets
the session model through `pi.setModel()`
([`mode-state.ts`](../../extensions/modes/src/mode-state.ts),
[`hooks.ts`](../../extensions/modes/src/hooks.ts)).

Mode overrides never touch subagents. The hook returns early for subagent
sessions — `if (isSubagentSession(ctx)) return;` — because a subagent already
resolved its own model through the subagent path above.

---

## Fallback order

For a chain-aware caller, resolution runs top to bottom and stops at the first hit:

1. A surface-specific explicit override, when present (for example a subagent `model` param or a `/mode-model` session override).
2. The configured chain: mode frontmatter, agent frontmatter, or a `tool_models.json` role/tool chain.
3. For each candidate in order: exact `provider/modelId`, then fuzzy match, against the profile-filtered available set.
4. Subagent config chains only: exact `registry.find()` ignoring the availability filter.
5. The surface-specific terminal fallback: a subagent param chain errors and the agent does not run; a subagent config chain uses the parent model; a mode chain makes no switch and the session keeps its current model; a profile force-switch follows the steps above; tool-role callers own their own terminal behavior.

---

## Extension-owned LLM calls

Some extensions make background LLM calls outside the main session model/mode path.
These use `tool_models.json` where possible, then pass the resulting chain through
the shared resolver:

- Role consumers and their keys are listed in [`extension-model-usage.md`](./extension-model-usage.md); chains live in root [`tool_models.json`](../../tool_models.json).
- An explicit `provider` + `model` in `session-summary.json` wins over the role chain for [`smart-sessions`](../../extensions/smart-sessions/index.ts).
- [`boomerang`](../../extensions/boomerang/commit.ts) applies its context-window eligibility gate after resolution.
- [`multimodal-look`](../../extensions/multimodal-look/index.ts) falls back to the current model only when it accepts image input.
- **`web-access`** (external `pi-web-access` git package) bypasses profiles: it tests `getApiKeyAndHeaders` against a fixed candidate list rather than reading `getAvailable()`.

---

## Runtime fallback layers

Resolution chooses an initial model. Two independent extension-level paths can
then react to a request failure; neither changes Pi core.

### Post-native-retry chain continuation

[`runtime-model-fallback.ts`](../../extensions/lib/runtime-model-fallback.ts) waits for
Pi to settle its native retries. Only then, after an assistant quota/rate-limit/access-denied
failure, it resolves the configured chain's authenticated identities in order and
switches to the next untried candidate. The failed assistant entry remains in the
transcript. A hidden continuation starts a new turn in that same transcript, retaining
completed tool results and never replaying the user prompt; the newly selected fallback
remains selected.

This coordinator is bound by [`modes/src/hooks.ts`](../../extensions/modes/src/hooks.ts)
for main-mode sessions only, using the active `/mode-model` override or mode chain. It
is also bound as the hidden `subagent-model-fallback` extension in
[`subagents/src/agent-runner.ts`](../../extensions/subagents/src/agent-runner.ts), so
configured subagents retain it even when isolated or excluded. An absent chain, an
exhausted chain, an abort signal/aborted message, context overflow, and every other
error stop recovery. It never cycles identities.

The generic coordinator applies a selected candidate's thinking level with Pi's API;
the caller owns Fast policy and validates/applies it. This path is for configured
chains only—parent-model inheritance is not a recovery chain. Subagent run/resume and
structured-output repair wait for the recovery turn to become idle.

### Runtime provider failover (clauderock)

`clauderock` instead swaps the provider *during* an Anthropic stream after a request
has failed. It installs by overriding the Anthropic provider's stream function —
`pi.registerProvider("anthropic", { streamSimple: streamWithFallback })`
([`index.ts`](../../extensions/clauderock/index.ts)) — so it wraps every Anthropic call
without changing which model the session selected.

**Trigger.** Inside the stream, an error switches to Bedrock only when all of these
hold ([`index.ts`](../../extensions/clauderock/index.ts)):

1. The error is a quota or rate-limit error (`isQuotaError` / `isRateLimitError`).
2. No response content has streamed yet (`!hasResponseContent`) — a mid-stream failure is forwarded, never retried.
3. The current model has a Bedrock mapping in `ANTHROPIC_TO_BEDROCK`.

Without a mapping, the error passes through and fallback stays off.

**Sticky state.** Once failover fires, `fallbackActive` flips true and a
`clauderock-state.json` cache is written under the agent dir. While active, the
wrapper routes every Bedrock-mapped call straight to Bedrock with no Anthropic
attempt, and the flag **persists across sessions** — session start reads the
cache back and re-arms failover ([`index.ts`](../../extensions/clauderock/index.ts)).
Reset it with `/clauderock off`; force it on with `/clauderock on`.

**ID normalization.** If a Bedrock-style id leaks into Pi state (for example after a
mode switch), `normalizeModelId` recovers the clean Anthropic id before resolving the
mapping, and outgoing events are patched back to the original id so the UI shows the
model the user picked.

**Scope.** This path activates only when the session model's provider is `anthropic`.
The `opencode` and `local` profiles never reach it. It is orthogonal to profile
filtering — it does not consult `getAvailable()` or `resolveModel` at all.

---

## Gotchas

- **Bare ids are ambiguous.** Prefer `provider/modelId` so resolution takes the exact path and skips fuzzy scoring.
- **`getAvailable()` is patched, not the data.** The profile filter wraps the method. Code that cached an earlier `getAvailable` reference, or that reads `getAll()`, escapes the filter.
- **`web-access` escapes the profile filter.** Its selectors auth-check a fixed candidate list, so a non-default profile can still reach Anthropic/OpenAI/Google credentials if they are present.
- **Config chains fail quietly; param chains fail loudly.** A typo in an agent's frontmatter model silently drops the agent onto the parent model; a typo in an explicit `model` param aborts the call with an error.
