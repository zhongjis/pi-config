# Agent-Model Family Matching

<!-- Adapted from oh-my-openagent's agent-model-matching guide (commit fbcdeab6). -->
<!-- License: SUL 1.0 — non-commercial/internal use with attribution. -->
<!-- Source: https://github.com/oh-my-openagent/oh-my-openagent -->
<!-- Local additions: corrective treatment for local/small models (Section 4). -->

## Models Are Developers

Varying model lineages require distinct prompting techniques. Performance isn't tied to personal taste, but to the specific data and methodologies used during a family's training.

Consider a technician and a scholar. Both process instructions, but their interpretations differ. The technician executes literal steps; the scholar evaluates the underlying logic. Neither approach fails — but a manual designed for the technician might frustrate the scholar.

Prompting strategies must align with these inherent model characteristics.

## The Three Families

| Family | Representative Models | Prompt Style | Why |
|--------|----------------------|--------------|-----|
| **Default** (Claude-like) | `anthropic/claude-opus-4-8`, `opencode-go/kimi-k2.6`, GLM, Qwen | Mechanics-driven: rigid protocols, explicit constraints, sequenced steps | Trained on extensive instruction sets; requires granular procedural detail for stable output |
| **GPT** | `openai-codex/gpt-5.5`, `openai/gpt-4o` | Principle-driven: high-level objectives, decision frameworks, minimal XML | Optimized for goal-following; dense instructions add noise; principle-based prompts facilitate cleaner execution |
| **Gemini** | `google/gemini-*`, `google-vertex/gemini-*` | Corrective overlays: precise overrides inserted at key structural points | Prone to specific agentic failures (see Section 3); overlays fix errors without rewriting the base prompt |

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
| **fuxi** | Strategic planner | `anthropic/claude-opus-4-6:xhigh` | Yes (`gpt.md`) | Yes (`gemini.md`) |
| **houtu** | Plan executor | `anthropic/claude-opus-4-8:xhigh` | No (v1) | No (v1) |
| **luban** | Superpowers discipline | `anthropic/claude-opus-4-8:xhigh` | No (v1) | No (v1) |

Variants exist for kuafu and fuxi as these modes handle complex user input where family-specific behavior is most evident.

## Local Addition: Small Models as Corrective

We leverage local chains (e.g., `llama-swap/qwen2.5-coder:14b`) alongside cloud services. Small models often bypass tools or finish early due to limited capacity rather than training bias.

Our `getModePromptSource` logic defaults local/small models to the **Default** family. They receive the detailed, mechanic-style Claude prompts for maximum guidance. Persistent failures in specific local models can trigger reclassification in `model-family.ts`.

## Family Detection

Logic relies on string matching:

- Provider starts with `google` or `google-vertex` -> Gemini
- Model ID contains `gpt` (case-insensitive) -> GPT
- Others (Claude, Kimi, GLM, Qwen, local) -> Default

Detection checks the Model ID to handle proxies (litellm, vellm, etc.) correctly.
