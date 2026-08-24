# Why agent prompts vary by model family

Model-specific prompt variants are not evidence that one vendor has a universally correct prompt style. They are compatibility layers: maintainers preserve one agent contract, then tune how that contract is expressed for model families whose instruction-following, reasoning mode, tool use, and regressions differ.

## TasteSkill: contextual default, stricter GPT variant

TasteSkill's public documentation names `design-taste-frontend` as its contextual default and `gpt-taste` as a stricter GPT/Codex-oriented variant.[1][2] It does **not** describe the default as Anthropic- or Claude-specific.

The default first classifies the brief—page type, audience, aesthetic, references, and constraints—then chooses design variance, motion, and density.[3] The GPT variant changes more than wording: it requires deterministic pseudo-random layout selection, a fixed AIDA structure, GSAP, gapless grids, and a pre-code `<design_plan>` verification block.[2]

TasteSkill documents an empirical reason for stronger rules: generated UIs repeatedly exhibited unwanted patterns, so v2 added hard rules, canonical code skeletons, and a pre-flight checklist.[1] That supports a narrow conclusion: this maintainer found stricter scaffolding more reliable for the GPT/Codex workflow they tested. It does not prove that every OpenAI model needs those rules or that Anthropic models do not.

## Oh My OpenAgent: explicit runtime routing

Oh My OpenAgent makes model variation part of its architecture. Its Sisyphus factory detects GPT, Claude, Kimi, and GLM families and selects distinct prompt builders and, in some cases, distinct agent config.[4] Atlas uses a centralized resolver and variant registry to choose separate GPT, Claude/Opus, Gemini, Kimi, and GLM prompt bodies.[5][6]

These variants can be complete prompt rewrites. The GPT Atlas prompt is outcome-first and organized around a few hard invariants; the default prompt carries longer procedural delegation, continuation, and verification mechanics.[7] Upstream's model-matching guide describes this as a deliberate policy: Claude-oriented orchestration is mechanics/checklist-driven, while GPT-oriented orchestration is principle/decision-driven.[6]

Treat that policy as project evidence, not vendor law. Upstream issue history shows why the routing layer matters: GPT-5.5 once missed the GPT-specific path because detection recognized GPT-5.4, and a later GPT-5.6 report found contradictory orchestration rules that needed model-aware tests.[8][9] Model IDs, prompt variants, and scenario tests therefore form one compatibility unit.

## What vendor guidance supports

Anthropic recommends explicit action language when implementation is intended, clear persistence and confirmation boundaries, and structured prompts for complex agent behavior.[10] Its guidance also covers XML structure and examples.[10] This supports explicit agent contracts, but does not establish that Claude always prefers longer prompts.

OpenAI distinguishes reasoning models from ordinary GPT models. Its reasoning guidance recommends simple, direct prompts; clear delimiters, constraints, end goals, and success criteria; and avoiding requests for chain-of-thought.[11] Its broader prompt guide says reasoning models can work from higher-level goals, while non-reasoning GPT models benefit from precise logic and workflow instructions.[12] OpenAI also recommends pinning model snapshots and running evals because behavior can change across snapshots.[12] Current model guidance advises changing one prompt section at a time, reducing repeated instructions, and rerunning representative evals instead of assuming that more instructions improve results.[13]

This produces a more accurate distinction than "Anthropic prompt" versus "OpenAI prompt":

- **Agent contract:** stable responsibilities, permissions, tool rules, completion criteria, and safety boundaries.
- **Model-family adapter:** different ordering, detail, examples, reminders, or decision framing used to make that contract reliable on a family.
- **Snapshot adapter:** narrower fixes for a specific model version or regression.
- **Evaluation suite:** scenarios proving that each adapter preserves the same contract.

## Why the variants exist

Three causes overlap:

1. **Different vendor guidance.** Reasoning and non-reasoning models are prompted differently even within OpenAI's own catalog.[11][12]
2. **Maintainer-observed behavior.** TasteSkill and Oh My OpenAgent encode patterns their authors found useful in their tested workflows.[1][6]
3. **Version drift.** New snapshots can miss routing rules or interpret old orchestration text differently, so maintainers add version-specific variants and tests.[8][9][12]

The strongest defensible claim is therefore practical: model-specific prompts are tested adapters around a shared behavioral contract. Claims such as "Claude needs mechanics" or "GPT needs principles" remain local heuristics until representative evals demonstrate them for the exact models and tasks in use.

## Implications for pi-config

This repo already follows the same broad design. [`mode-prompt-parity.md`](../../specs/mode-prompt-parity.md) defines stable local mode invariants, then permits default, GPT replacement, and Gemini overlay bodies. Generated Oh My OpenAgent prompt snapshots live in [`final-prompts/`](./final-prompts/), while [`model-selection-and-fallback.md`](../../specs/model-selection-and-fallback.md) separately governs model selection.

Keep those concerns separate:

- Put invariant role, authorization, delegation, and verification semantics in the mode contract.
- Add a family variant only for observed behavioral differences, not vendor branding.
- Prefer small overlays when they can preserve the base contract; use full replacements only when prompt architecture must change.
- Route centrally, define explicit fallback behavior, and test model IDs so a new snapshot cannot silently receive the wrong prompt.
- Evaluate equivalent scenarios across variants: implementation authorization, tool use, delegation, continuation, user approval, and completion claims.
- Record each variant's evidence: vendor guidance, observed failure, affected model IDs, and the eval that proves the fix.

`tool_models.json` should continue to choose model chains, not prompt text. Prompt-family routing belongs with mode or agent prompt construction, where the behavioral contract and its tests are visible together.

## Sources

- [1] TasteSkill documentation and changelog ([docs](https://www.tasteskill.dev/docs), [changelog](https://www.tasteskill.dev/changelog))
- [2] TasteSkill README and GPT variant ([README](https://github.com/Leonxlnx/taste-skill/blob/72e299530e2eb31ed8da06181bc19f6c18a00821/README.md#L141-L179), [`gpt-tasteskill/SKILL.md`](https://github.com/Leonxlnx/taste-skill/blob/72e299530e2eb31ed8da06181bc19f6c18a00821/skills/gpt-tasteskill/SKILL.md#L1-L74))
- [3] TasteSkill contextual default ([`taste-skill/SKILL.md`](https://github.com/Leonxlnx/taste-skill/blob/72e299530e2eb31ed8da06181bc19f6c18a00821/skills/taste-skill/SKILL.md#L6-L60))
- [4] Oh My OpenAgent Sisyphus model routing ([factory](https://github.com/code-yeongyu/oh-my-openagent/blob/14083b89f1cbf4680be13493a6c4afd67c957e8a/packages/omo-opencode/src/agents/sisyphus-agent-factory.ts#L40-L151))
- [5] Oh My OpenAgent Atlas routing ([agent](https://github.com/code-yeongyu/oh-my-openagent/blob/14083b89f1cbf4680be13493a6c4afd67c957e8a/packages/omo-opencode/src/agents/atlas/agent.ts#L1-L74))
- [6] Oh My OpenAgent variant registry, resolver, and model guide ([registry](https://github.com/code-yeongyu/oh-my-openagent/blob/14083b89f1cbf4680be13493a6c4afd67c957e8a/packages/prompts-core/src/atlas-prompts.ts#L1-L52), [resolver](https://github.com/code-yeongyu/oh-my-openagent/blob/14083b89f1cbf4680be13493a6c4afd67c957e8a/packages/prompts-core/src/variant-resolver.ts#L21-L61), [guide](https://github.com/code-yeongyu/oh-my-openagent/blob/14083b89f1cbf4680be13493a6c4afd67c957e8a/docs/guide/agent-model-matching.md#L35-L88))
- [7] Oh My OpenAgent GPT Atlas prompt ([source](https://github.com/code-yeongyu/oh-my-openagent/blob/14083b89f1cbf4680be13493a6c4afd67c957e8a/packages/prompts-core/prompts/atlas/gpt.md#L1-L24))
- [8] Oh My OpenAgent GPT-5.5 routing regression ([issue #3601](https://github.com/code-yeongyu/oh-my-openagent/issues/3601))
- [9] Oh My OpenAgent GPT-5.6 orchestration prompt defect ([issue #6074](https://github.com/code-yeongyu/oh-my-openagent/issues/6074))
- [10] Anthropic prompting best practices (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [11] OpenAI reasoning best practices (https://developers.openai.com/api/docs/guides/reasoning-best-practices)
- [12] OpenAI prompt engineering (https://developers.openai.com/api/docs/guides/prompt-engineering)
- [13] OpenAI latest-model prompt guidance (https://developers.openai.com/api/docs/guides/latest-model)
