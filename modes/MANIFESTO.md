# Agent-Model Family Matching

<!-- Adapted from oh-my-openagent's agent-model-matching guide (commit fbcdeab6). -->
<!-- License: SUL 1.0 — non-commercial/internal use with attribution. -->
<!-- Source: https://github.com/oh-my-openagent/oh-my-openagent -->
<!-- Local additions: corrective treatment for local/small models (Section 4). -->

## Models Are Developers

Varying model lineages require distinct prompting techniques. Performance isn't tied to personal taste, but to the specific data and methodologies used during a family's training.

Consider a technician and a scholar. Both process instructions, but their interpretations differ. The technician executes literal steps; the scholar evaluates the underlying logic. Neither approach fails — but a manual designed for the technician might frustrate the scholar.

Prompting strategies must align with these inherent model characteristics.

In practice the difference is narrower than it looks: current GPT-5.x reasoning models also want explicit, structured instructions. The GPT-specific levers are contradiction-sensitivity and reasoning-effort tuning, not "principles instead of steps."

## The Three Families

| Family | Representative Models | Prompt Style | Why |
|--------|----------------------|--------------|-----|
| **Default** (Claude-like) | `anthropic/claude-opus-4-8`, `opencode-go/kimi-k2.6`, GLM, Qwen | Mechanics-driven: rigid protocols, explicit constraints, sequenced steps | Trained on extensive instruction sets; requires granular procedural detail for stable output |
| **GPT** (5.x reasoning) | `openai-codex/gpt-5.6-sol` and other GPT-5.x reasoning models | Explicit constraints inside light XML structure; scope, verbosity, and format stated once; reasoning effort set deliberately | Strong instruction adherence, but sensitive to contradictory or redundant rules. Keep structure; the failure mode is conflict/repetition, not XML or rule count. |
| **Gemini** | `google/gemini-*`, `google-vertex/gemini-*` | Corrective overlays: precise overrides inserted at key structural points | Prone to specific agentic failures (see Section 3); overlays fix errors without rewriting the base prompt |

Note on the GPT family: current OpenAI guidance for GPT-5.2 uses XML spec blocks throughout its prompting patterns and asks for "clear and concrete length constraints" plus explicit scope limits [1]. GPT-5.x reasoning models are not helped by vaguer prompts; they are hurt by conflicting or redundant instructions [2]. Before editing a GPT prompt, first set reasoning effort correctly (GPT-5.2 defaults to `none`) and measure with evals. OpenAI's own order is: switch the model, hold the prompt constant, pin reasoning effort, run evals, then tune the prompt only if evals regress [1].

## Gemini-Specific Failure Modes

Research identifies three typical regressions in Gemini-class models:

1. **Information Burial**: Instructions positioned in prompt centers often lose weight. Solution: place corrective overlays immediately before `<critical>` tags to hit peak attention zones.
2. **Tool Neglect**: Gemini often hallucinates answers instead of utilizing available tools. Solution: insert mandatory tool usage overrides.
3. **Premature Termination**: High confidence calibration leading to "done" declarations before validation. Solution: verification hooks that mandate explicit checks.

Short, forceful overlays maintain context while mitigating these known weaknesses.

## Our Mode Mapping

| Mode | Role | Default Model | GPT Variant | Gemini Variant |
|------|------|--------------|-------------|----------------|
| **kuafu** | Build orchestrator | `anthropic/claude-opus-4-8:xhigh` | Yes (`gpt.md`) | Yes (`gemini.md`) |
| **fuxi** | Strategic planner | `anthropic/claude-opus-4-8:xhigh` | Yes (`gpt.md`) | Yes (`gemini.md`) |
| **houtu** | Plan executor | `anthropic/claude-sonnet-4-6` | Yes (`gpt.md`) | Yes (`gemini.md`) |
| **luban** | Superpowers discipline | `anthropic/claude-opus-4-8:xhigh` | Yes (`gpt.md`) | Yes (`gemini.md`) |
| **shennong** | Product judgment | `anthropic/claude-opus-4-8:xhigh` | Yes (`gpt.md`) | Yes (`gemini.md`) |

All five modes have default/GPT/Gemini prompt coverage. GPT files are standalone replacement bodies; Gemini files are corrective overlays on default bodies.

## Local Addition: Small Models as Corrective

We leverage local chains (e.g., `llama-swap/qwen2.5-coder:14b`) alongside cloud services. Small models often bypass tools or finish early due to limited capacity rather than training bias.

Our `getModePromptSource` logic defaults local/small models to the **Default** family. They receive the detailed, mechanic-style Claude prompts for maximum guidance. Persistent failures in specific local models can trigger reclassification in `model-family.ts`.

## Family Detection

Logic relies on string matching:

- Provider starts with `google` or `google-vertex` -> Gemini
- Model ID contains `gpt` (case-insensitive) -> GPT
- Others (Claude, Kimi, GLM, Qwen, local) -> Default

Detection checks the Model ID to handle proxies (litellm, vellm, etc.) correctly.

GPT detection limitation: the `gpt` substring match cannot distinguish non-reasoning `gpt-4o` from GPT-5.x reasoning models, so both resolve to the same `gpt.md`. The corrected GPT guidance above is scoped to GPT-5.x reasoning models; detection cannot currently honor that version boundary.

## Sources

- [1] Model guidance — Using GPT-5.2, OpenAI (https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)
- [2] GPT-5.1 Prompting Guide, OpenAI Cookbook (https://cookbook.openai.com/examples/gpt-5/gpt-5-1_prompting_guide)
