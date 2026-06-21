# Model Selection and Fallback

How a model gets chosen, and what happens when the chosen one is unavailable.

This document describes the engine. Profiles, modes, subagents, and tool-model
roles feed it; one shared library does the parsing and matching. The companion
docs below build on this engine; read this first when the question is *how*
selection works, not *which* model a given agent or extension uses.

Companion docs:

- [`extension-model-usage.md`](./extension-model-usage.md) — `tool_models.json` roles for extension-owned LLM calls.
- [`opencode-agent-models.md`](./opencode-agent-models.md) — per-agent model assignments on the `opencode` profile.
- [`../extensions/profiles/README.md`](../extensions/profiles/README.md) — profile commands, flags, and config fields.
- [`./modes.md`](./modes.md) — mode switching and frontmatter.
Source is authoritative. Where a catalog doc disagrees with code, trust the code paths cited here.

---

## The five surfaces

Each surface decides a different question. They compose; none replaces another.

| Surface | Decides | Mechanism | Source |
|---|---|---|---|
| **Shared library** | How a spec string resolves to a model | `parseModelChain` + `resolveModel` + `resolveFirstAvailable` | [`extensions/lib/model.ts`](../extensions/lib/model.ts) |
| **Profiles** | Which models are visible at all | Patches `registry.getAvailable()` to a provider allowlist; force-switches the session model | [`extensions/profiles/index.ts`](../extensions/profiles/index.ts) |
| **Modes** | Which model the main session uses per mode | Applies mode-frontmatter `model:` through the shared library | [`extensions/modes/src/`](../extensions/modes/src/) |
| **Subagents** | Which model each agent runs on | Resolves the `model` param or agent-config chain, falling back to the parent model | [`extensions/subagent/src/`](../extensions/subagent/src/) |
| **Tool model roles** | Which model extension-owned background LLM calls use | `tool_models.json` maps tool keys to role chains, then resolves through the shared library | [`extensions/lib/tool-models.ts`](../extensions/lib/tool-models.ts), [`extension-model-usage.md`](./extension-model-usage.md) |

The profile filter sits under everything: every `getAvailable()` call the other
surfaces make already returns a profile-filtered list.

Runtime failover is separate: `clauderock` switches provider after a request
fails mid-flight, independent of all resolution-time selection above. See
[Runtime provider failover](#runtime-provider-failover-clauderock).

---

## Spec string format

A model spec is `provider/modelId:thinkingLevel`. The provider and thinking
level are optional. A comma joins specs into a chain.

```
gpt-5.4-mini, claude-haiku-4-5, opencode-go/qwen3.5-plus:high, llama-swap/qwen2.5-coder:7b
```

Two functions parse this ([`model.ts:41-62`](../extensions/lib/model.ts)):

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
an error string ([`model.ts:77-141`](../extensions/lib/model.ts)). It reads from
`registry.getAvailable?.() ?? registry.getAll()`, so it sees only authed,
profile-allowed models.

Two strategies run in order:

1. **Exact `provider/modelId`** — matches only when the full id is in the
   available set. This is the safe path: it never resolves to an unavailable or
   wrong-provider model.
2. **Fuzzy score** — when no exact match applies, every available model gets a
   score, and the highest wins if it reaches 20.

Fuzzy scoring, highest first:

| Condition | Score |
|---|---|
| Query equals model id or `provider/id` | 100 |
| Query is a substring of the id or `provider/id` | 60 + length ratio × 30 |
| Query is a substring of the display name | 40 + length ratio × 20 |
| Every query part appears in id, name, or provider | 20 |

Fuzzy matching is why a bare `qwen3.5-plus` is risky: when two providers both
register that id, the fuzzy pass may pick the wrong one. Prefix the provider
(`opencode-go/qwen3.5-plus`) to force the exact path.

**`resolveFirstAvailable(candidates, registry)`** walks a parsed chain and
returns the first candidate that resolves, with its thinking level
([`model.ts:147-158`](../extensions/lib/model.ts)). It returns `undefined` when
the whole chain fails. This is the core fallback primitive — every chain-aware
caller uses it.

---

## Profile filtering

A profile narrows the visible provider set. The `opencode` profile, for
example, hides every model except OpenCode Go's.

**Registry patch.** `installModelRegistryFilter` wraps `registry.getAvailable`
once ([`profiles/index.ts:178-199`](../extensions/profiles/index.ts)). When a
profile is active, the wrapped method filters the original result to the
profile's allowed providers. When no profile is active, it returns the original
list untouched. Every selection path that calls `getAvailable()` — the `/model`
picker, mode resolution, subagent resolution, and chain walks — inherits this
filter for free.

**Force-switch.** When a profile activates and the current session model sits
outside the allowlist, `forceProfileModel` moves the session onto a profile
model ([`profiles/index.ts:252-270`](../extensions/profiles/index.ts)):

1. If the current model's provider is already allowed, do nothing.
2. Otherwise resolve the profile's `defaultModel` through `resolveModel`.
3. If that fails, take the first available model from an allowed provider.
4. If nothing is available, notify `Profiles: no model available for providers: …` and leave the model unchanged.

Built-in profile configs ([`profiles/index.ts:68-102`](../extensions/profiles/index.ts)):

| Profile | Allowed providers | `defaultModel` |
|---|---|---|
| `default` | `anthropic`, `openai-codex`, `openai`, `amazon-bedrock`, `google` | `anthropic/claude-opus-4-7` |
| `opencode` | `opencode-go` | `opencode-go/kimi-k2.6` |
| `local` | `llama-swap` | `llama-swap/qwen2.5-coder:14b` |

The `local` profile also blocks the `wenchang` agent and the web tools, and
injects an offline system prompt.

**Activation precedence**, first match wins
([`profiles/index.ts`, `resolveInitialProfile`](../extensions/profiles/index.ts)):

1. `--profile <name>` CLI flag.
2. `panda:profile` session-journal entry (from a prior `/profile` or `--profile`).
3. `PI_PROFILE` environment variable.
4. Hardcoded `default`.

---

## Subagent resolution

A subagent picks its model in strict priority order: explicit invocation param,
then agent-config chain, then the parent model
([`agent-runner.ts:51-91`](../extensions/subagent/src/agent-runner.ts),
[`invocation-config.ts:29-31`](../extensions/subagent/src/invocation-config.ts)).

`resolveAgentInvocationConfig` computes the raw model and records its origin:

```
rawModel       = agentConfig?.model ?? params.model
modelFromParams = agentConfig?.model == null && params.model != null
```

The agent config wins over the tool param. The `modelFromParams` flag matters
only for how a *failed* chain behaves.

**When the chain fails, the origin decides the outcome**
([`index.ts:1059-1079`](../extensions/subagent/src/index.ts)):

| Chain origin | All candidates fail | Result |
|---|---|---|
| Tool param (`modelFromParams`) | Return the first candidate's error string | Agent does not run |
| Agent config | Silent fallback to the parent model | Agent runs on parent model |

An explicit caller override gets a hard error so the mistake surfaces; a config
default degrades quietly so a missing model never blocks delegation.

**One extra config-chain fallback.** `resolveDefaultModel` adds a step beyond
`resolveFirstAvailable`
([`agent-runner.ts:55-91`](../extensions/subagent/src/agent-runner.ts)): if the
chain resolves nothing through `getAvailable()`, it retries each
`provider/modelId` candidate against `registry.find()` directly, bypassing the
availability filter. Only then does it fall back to the parent model with a
`[subagent] Could not resolve any model … Falling back to parent model` warning.

**Agent-type defaults** ([`default-agents.ts`](../extensions/subagent/src/default-agents.ts)):

| Built-in agent | Model |
|---|---|
| `general-purpose` | None — inherits the parent model |
| `Explore` | `anthropic/claude-haiku-4-5-20251001` (hardcoded) |
| `Plan` | None — inherits the parent model |

User `.md` agents with the same name override these defaults. An unknown or
disabled agent type falls back to `general-purpose`
([`agent-types.ts`](../extensions/subagent/src/agent-types.ts)).

---

## Mode resolution

A mode can pin the main session's model through its frontmatter `model:` field,
read from `~/.pi/agent/agents/<mode>.md`
([`config-loader.ts`](../extensions/modes/src/config-loader.ts)). On mode switch,
`applyModelFromConfig` parses the chain, calls `resolveFirstAvailable`, and sets
the session model through `pi.setModel()`
([`mode-state.ts`](../extensions/modes/src/mode-state.ts),
[`hooks.ts`](../extensions/modes/src/hooks.ts)).

Mode overrides never touch subagents. The hook returns early for subagent
sessions — `if (isSubagentSession(ctx)) return;` — because a subagent already
resolved its own model through the subagent path above.

---

## Full fallback order

For a chain-aware caller under an active profile, resolution runs top to bottom
and stops at the first hit:

1. Surface-specific explicit override, when present:
   - smart-sessions legacy `session-summary.json` `provider` + `model`.
   - subagent explicit `model` param.
   - mode session override from `/mode-model`.
2. Configured chain source: mode frontmatter, agent frontmatter, or `tool_models.json` role/tool chain.
3. Explicit `provider/modelId`, available and authed → use it.
4. Fuzzy match against the profile-filtered available set (score ≥ 20) → use the best.
5. Next candidate in the chain → repeat 3–4.
6. (Subagent config chains only) exact `registry.find()` ignoring the availability filter.
7. Surface-specific terminal fallback:
   - Subagent param chain → error, agent aborts.
   - Subagent config chain → parent model.
   - Mode chain → no switch; session keeps its current model.
   - Tool model role chain → caller-specific fallback; boomerang commit keeps current model with warning, smart-sessions records no summary model available.
   - Profile force-switch → first allowed available model, else no change with an error notice.

---

## Extension-owned LLM calls

Some extensions make background LLM calls outside the main session model/mode path.
These use `tool_models.json` where possible, then pass the resulting chain through
the shared resolver:

- **`smart-sessions`** ([`index.ts`](../extensions/smart-sessions/index.ts)) — legacy explicit `provider`+`model` still wins; blank/missing fields resolve `smart-sessions.summary` → `summary.session`.
- **`boomerang`** ([`commit.ts`](../extensions/boomerang/commit.ts)) — resolves `boomerang.commit` → `commit`, then applies its context-window eligibility gate before choosing a target model.
- **`multimodal-look`** ([`index.ts`](../extensions/multimodal-look/index.ts)) — vision chain, falling back to the current model only when it accepts image input.
- **`web-access`** (external `pi-web-access` git package — `index.ts`, `summary-review.ts`) — profile-bypassing: tests `getApiKeyAndHeaders` against a candidate list rather than reading `getAvailable()`. Known gap until those selectors migrate to shared role config.

---

## Runtime provider failover (clauderock)

Everything above resolves a model *before* a turn runs. `clauderock` is
different: it swaps the provider *during* the stream, after a request has
already failed. It installs by overriding the Anthropic provider's stream
function — `pi.registerProvider("anthropic", { streamSimple: streamWithFallback })`
([`index.ts:962-965`](../extensions/clauderock/index.ts)) — so it wraps every
Anthropic call without changing which model the session selected.

**Trigger.** Inside the stream, an error switches to Bedrock only when all of
these hold ([`index.ts:361-392`](../extensions/clauderock/index.ts)):

1. The error is a quota or rate-limit error (`isQuotaError` / `isRateLimitError`).
2. No response content has streamed yet (`!hasResponseContent`) — a mid-stream failure is forwarded, never retried.
3. The current model has a Bedrock mapping in `ANTHROPIC_TO_BEDROCK` ([`index.ts:25-32`](../extensions/clauderock/index.ts)).

Without a mapping, the error passes through and fallback stays off. The mapping
covers `claude-sonnet-4-6`, `claude-opus-4-6/4-7/4-8`, and `claude-haiku-4-5`.

**Sticky state.** Once failover fires, `fallbackActive` flips true and a
`clauderock-state.json` cache is written under the agent dir. While active, the
wrapper routes every Bedrock-mapped call straight to Bedrock with no Anthropic
attempt, and the flag **persists across sessions** — session start reads the
cache back and re-arms failover ([`index.ts:590-603`](../extensions/clauderock/index.ts)).
Reset it with `/clauderock off`; force it on with `/clauderock on`.

**ID normalization.** If a Bedrock-style id leaks into pi state (e.g. after a
mode switch), `normalizeModelId` recovers the clean Anthropic id before
resolving the mapping ([`index.ts:50-52`](../extensions/clauderock/index.ts)),
and outgoing events are patched back to the original id so the UI shows the
model the user picked.

**Scope.** This path activates only when the session model's provider is
`anthropic`. The `opencode` and `local` profiles never reach it. It is
orthogonal to profile filtering — it does not consult `getAvailable()` or
`resolveModel` at all.

---

## Gotchas

- **Bare ids are ambiguous.** Prefer `provider/modelId` so resolution takes the exact path and skips fuzzy scoring.
- **`getAvailable()` is patched, not the data.** The profile filter wraps the method. Code that cached an earlier `getAvailable` reference, or that reads `getAll()`, escapes the filter.
- **`web-access` escapes the profile filter.** Its selectors auth-check a fixed candidate list, so a non-default profile can still reach Anthropic/OpenAI/Google credentials if they are present.
- **Config chains fail quietly; param chains fail loudly.** A typo in an agent's frontmatter model silently drops the agent onto the parent model; a typo in an explicit `model` param aborts the call with an error.
