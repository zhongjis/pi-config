# Agent-Model Family Matching

<!-- Adapted from oh-my-openagent's agent-model-matching guide (commit fbcdeab6). -->
<!-- License: SUL 1.0 — non-commercial/internal use with attribution. -->
<!-- Source: https://github.com/oh-my-openagent/oh-my-openagent -->
<!-- Local additions: local-practice labels, the parity rule, the GPT quirks (OpenAI sources), and small-model corrective treatment. -->

## Models Are Developers

Model families have distinct quirks that come from their training data and methods. Behavior stays the same across families; prompt style adapts to each family.

Shared instructions can serve several families. Check that they do not overconstrain GPT models: advice that helps one model can overconstrain another [2].

## Parity Rule

`mode.md` is canonical for behavior. A family file restates it and differs only in style for documented quirks.

## Local Addition: GPT Overwork Habits

Local observation from an A/B eval of real Kua Fu tasks on `gpt-6.1-sol`: under the old prompts, GPT delegated small work, added ceremony (notepads, task lists, extra subagents) to small tasks, re-ran passing checks, handed one worker a whole UI for 25+ minutes, wrote tests for prototypes, and gave long answers. [`modes/kuafu/gpt.md`](kuafu/gpt.md) names these habits so the model can catch them; the behavior it asks for is the same as `mode.md`.

## The Three Families

| Family | Detection | Prompt Style | Why |
|--------|-----------|--------------|-----|
| **Default** (Claude-like) | Every model not detected as GPT or Gemini | Mechanics-driven: rigid protocols, explicit constraints, sequenced steps | Local practice, no vendor source verified: these models need granular procedural detail for stable output |
| **GPT** | Model ID contains `gpt` (checked first) | Softer emphasis, explicit done criteria and safe autonomy, each rule stated once, short recipes [1][2] | See [GPT Quirks](#gpt-quirks) |
| **Gemini** | Provider starts with `google`, or model ID contains `gemini` | Corrective overlays: precise overrides inserted at key structural points | Prone to specific agentic failures (see [Gemini-Specific Failure Modes](#gemini-specific-failure-modes)); overlays fix errors without rewriting the base prompt |

See [`model-family.ts`](../extensions/lib/model-family.ts) for the detection code.

## GPT Quirks

A `gpt.md` may handle these quirks in style only:

- **Softer emphasis.** Strong boundary language written for earlier models can stop GPT early [2].
- **Explicit done criteria and safe autonomy.** State the result, audience, context, constraints, and what counts as done [1]. Name what may proceed independently and what needs approval, and which safe workflows run without repeated approval; GPT can be tentative about when to stop [1][2].
- **Each rule stated once.** Contradictory or over-emphasized instructions hurt results [2].
- **Shorter recipes** where the outcome stays the same. Overly specific recipes can hinder results [2].

Reasoning effort is a model setting, not prompt style: set it with the model spec's thinking-level suffix ([model selection](../docs/specs/model-selection-and-fallback.md)). Start from the model's default level and adjust to task difficulty: Low for routine tasks, Medium for judgment, High for difficult analysis, and Extra high or Max when High falls short [1].

## Gemini-Specific Failure Modes

Research identifies three typical regressions in Gemini-class models:

1. **Information Burial**: Instructions positioned in prompt centers often lose weight. Solution: place corrective overlays immediately before `<critical>` tags to hit peak attention zones.
2. **Tool Neglect**: Gemini often hallucinates answers instead of utilizing available tools. Solution: insert mandatory tool usage overrides.
3. **Premature Termination**: High confidence calibration leading to "done" declarations before validation. Solution: verification hooks that mandate explicit checks.

Short, forceful overlays maintain context while mitigating these known weaknesses.

## Our Mode Mapping

[`modes/README.md`](README.md) owns the active mode set and how each family's prompt file is built. Each mode's `mode.md` frontmatter owns its default model.

## Local Addition: Small Models as Corrective

Local observation: small local models often bypass tools or finish early because of limited capacity rather than training bias.

[`getModePromptSource`](../extensions/lib/model-family.ts) defaults local/small models to the **Default** family, so they receive the detailed, mechanic-style prompts. Reclassify a local model in that file when it fails persistently.

## Family Detection

[`extensions/lib/model-family.ts`](../extensions/lib/model-family.ts) owns detection. GPT detection matches on the model ID, not the provider name, so proxied models (litellm and similar) resolve to their real family. Gemini detection also accepts a `google` provider prefix.

Limitation: GPT detection cannot distinguish non-reasoning GPT models from reasoning models, so both use `gpt.md`. The GPT guidance above targets the GPT-6 family.

## Sources

- [1] OpenAI, "A model guide for the GPT-6 family" (https://openai.com/index/practical-guide-building-gpt-6/)
- [2] OpenAI Developers, "Rethinking skills and prompts for GPT-6 Astra" (https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra#better-skills)
