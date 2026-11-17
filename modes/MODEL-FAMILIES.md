# Agent-Model Family Matching

<!-- Adapted from oh-my-openagent's agent-model-matching guide (commit fbcdeab6). -->
<!-- License: SUL 1.0 — non-commercial/internal use with attribution. -->
<!-- Source: https://github.com/oh-my-openagent/oh-my-openagent -->
<!-- Local additions: local-practice labels, the parity rule, the GPT quirks (OpenAI sources), and small-model corrective treatment. -->

## Models Are Developers

Model families share task semantics, authorization, safety, specialist boundaries, and completion standards. Each family's prompt is authored for that model's execution characteristics.

Shared instructions can serve several families. Check that they do not overconstrain GPT models: advice that helps one model can overconstrain another [2].

## Parity Rule

`default.md` supplies the default prompt, not a template that other families must restate. Family prompts may differ in structure, emphasis, workflow detail, and communication cadence while preserving shared contracts. Evaluate parity by outcomes, not matching wording or sections.

## The Three Families

| Family | Detection | Prompt Style | Why |
|--------|-----------|--------------|-----|
| **Default** (Claude-like) | Every model not detected as GPT or Gemini | Procedural baseline with explicit constraints and sequenced steps | Established local practice; effectiveness is workload-dependent, not a universal claim about Claude |
| **GPT** | Model ID contains `gpt` (checked first) | Outcome-first conditions, explicit autonomy and completion criteria, bounded verification [2][4] | See [GPT Quirks](#gpt-quirks) |
| **Gemini** | Provider starts with `google`, or model ID contains `gemini` | Corrective overlays: precise overrides inserted at key structural points | Prone to specific agentic failures (see [Gemini-Specific Failure Modes](#gemini-specific-failure-modes)); overlays fix errors without rewriting the base prompt |

See [`model-family.ts`](../extensions/lib/model-family.ts) for the detection code.

## GPT Quirks

GPT prompts target GPT-6.2. Its prompting guidance covers behavior observed on both Astra and Sol [4]. GPT-6 sources [1][2][3] apply where the GPT-6.2 guidance is silent. Instructions that help Sol or Luna may overconstrain Astra [2]. These sources do not establish a universal GPT-versus-Claude prompting rule.

A `gpt.md` may adapt its instructions to these observed behaviors:

- **Concise by default.** Revisit "be concise" instructions written for earlier models [4].
- **Task completion.** When intent is unclear, GPT-6.2 may propose a next step and wait. Name the authorized next steps; stop only for a significant scope change, a concrete block, a decision the user must make, or an irreversible or destructive action [4].
- **Reasonable assumptions.** Allow reasonable, reversible assumptions that keep work in scope, stated to the user [4].
- **Self-contained final answer.** The final answer must not depend on earlier progress updates or carry shorthand from reasoning, tool calls, or subagent messages [4].
- **Fewer new tests.** Skip new tests unless requested, required by the repository, or needed to catch a regression existing tests would miss [4].
- **Prefix stability.** The API drops reasoning items when instructions or tool calls change mid-conversation, which can lower quality and repeat work. Keep the prompt prefix and tool set stable within a session [4].
- **Softer emphasis.** Strong boundary language written for earlier models can stop GPT early [2].
- **Explicit done criteria and safe autonomy.** State the result, audience, context, constraints, and what counts as done [1]. Name what may proceed independently and what needs approval, and which safe workflows run without repeated approval; GPT can be tentative about when to stop [1][2].
- **Each rule stated once.** Contradictory or over-emphasized skill descriptions lead the model to load guidance that does not help [2]; applying the same caution to prompt bodies is a local extrapolation.
- **Shorter recipes** where the outcome stays the same. Overly specific recipes can hinder results [2].

Reasoning effort is a model setting, not prompt style: set it with the model spec's thinking-level suffix ([model selection](../docs/specs/model-selection-and-fallback.md)). Start at `medium` [4], then adjust to task difficulty: Low for routine tasks, Medium for judgment, High for difficult analysis, and Extra high or Max when High falls short [1].

## Gemini-Specific Failure Modes

Research identifies three typical regressions in Gemini-class models:

1. **Information Burial**: Instructions positioned in prompt centers often lose weight. Solution: place corrective overlays immediately before `<critical>` tags to hit peak attention zones.
2. **Tool Neglect**: Gemini often hallucinates answers instead of utilizing available tools. Solution: insert mandatory tool usage overrides.
3. **Premature Termination**: High confidence calibration leading to "done" declarations before validation. Solution: verification hooks that mandate explicit checks.

Short, forceful overlays maintain context while mitigating these known weaknesses.

## Our Mode Mapping

[`modes/README.md`](README.md) owns the active mode set and how each family's prompt file is built. Each mode's `default.md` frontmatter owns its default model. Directory-form agents use the same families and files ([agents/AGENTS.md](../agents/AGENTS.md)).

## Local Addition: Small Models as Corrective

Local observation: small local models often bypass tools or finish early because of limited capacity rather than training bias.

[`getModePromptSource`](../extensions/lib/model-family.ts) defaults local/small models to the **Default** family, so they receive the detailed, mechanic-style prompts. Reclassify a local model in that file when it fails persistently.

## Family Detection

[`extensions/lib/model-family.ts`](../extensions/lib/model-family.ts) owns detection. GPT detection matches on the model ID, not the provider name, so proxied models (litellm and similar) resolve to their real family. Gemini detection also accepts a `google` provider prefix.

Limitation: GPT detection cannot distinguish non-reasoning GPT models from reasoning models, or GPT-6.2 from earlier GPT models, so all use `gpt.md`. GPT-6 Luna has no GPT-6.2 successor; evaluate the guidance separately on each GPT model the harness uses.

## Sources

- [1] OpenAI, "A model guide for the GPT-6 family" (https://openai.com/index/practical-guide-building-gpt-6/)
- [2] OpenAI Developers, "Rethinking skills and prompts for GPT-6 Astra" (https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra#better-skills)
- [3] OpenAI Developers, "GPT-6 Astra: Prompting best practices" (https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra#prompting-best-practices)
- [4] OpenAI Developers, "Using GPT-6.2: Prompting best practices" (https://developers.openai.com/api/docs/guides/latest-model/gpt-6.2-astra#prompting-best-practices)
