# Mode Prompt Parity Spec

Purpose: record accepted Oh My OpenAgent (omo) synchronization baselines and local behavioral invariants. This is a behavior-parity guide, not an exact-copy mandate.

## Upstream Baseline

- Accepted omo release baseline: `v4.19.0`.
- Upstream repo: `https://github.com/code-yeongyu/oh-my-openagent`.
- Current Oh My OpenAgent reference archive: generated final prompts at `docs/references/oh-my-openagent/final-prompts/` and byte-identical raw upstream `ulw-plan` skill baseline at `docs/references/oh-my-openagent/skills/ulw-plan/`; refresh with `pnpm sync:oh-my-openagent-prompts`, verify with `pnpm check:oh-my-openagent-prompts`, never hand-edit archive files. The archive README pins the source SHA.
- Earlier path-level audit evidence used commit `f7ec55526b2a3603665c5c0308b031a4f14900b0`; it remains evidence for the paths below, not the current release baseline.
- Superpowers repo: `https://github.com/obra/superpowers`, `main` inspected at commit `896224c4b1879920ab573417e68fd51d2ccc9072`, path `skills/`.

Required upstream paths verified in the earlier `f7ec55526b2a3603665c5c0308b031a4f14900b0` audit:

- `packages/omo-opencode/src/agents/sisyphus-agent-factory.ts`
- `packages/omo-opencode/src/agents/prometheus/system-prompt.ts`
- `packages/omo-opencode/src/agents/atlas/agent.ts`
- `packages/prompts-core/src/atlas-prompts.ts`

Relevant generated final prompt baselines located:

- Sisyphus: `docs/references/oh-my-openagent/final-prompts/sisyphus/*.md` (model-family final prompts generated from TypeScript builders).
- Prometheus: `docs/references/oh-my-openagent/final-prompts/prometheus/default.md`.
- Atlas: `docs/references/oh-my-openagent/final-prompts/atlas/{default,gpt,gemini,glm,kimi,kimi-k2-7,opus-4-7}.md`.
- Fu Xi upstream `ulw-plan` baseline: `docs/references/oh-my-openagent/skills/ulw-plan/{SKILL.md,agents/openai.yaml,references/full-workflow.md,references/intent-clear.md,references/intent-unclear.md,scripts/scaffold-plan.mjs}`.

## Applied v4.16.3 Agent Mappings

Accepted, applied local mappings:

- [`agents/chengfeng.md`](../../agents/chengfeng.md) maps omo Explorer-style read-only reconnaissance to Chengfeng, preserves Pi CodeGraph/LSP/literal-search contracts, and adds `openai-codex/gpt-5.6-terra:medium` to its model chain.
- [`agents/wenchang.md`](../../agents/wenchang.md) maps omo Librarian-style external research to Wenchang, preserves opened-source citation safeguards, and adds `openai-codex/gpt-5.6-terra:medium` to its model chain.
- [`agents/jintong.md`](../../agents/jintong.md) uses `opencode-go/glm-5.2:high` for its OpenCode Go implementation-worker mapping.
- [`agents/juling.md`](../../agents/juling.md) uses `opencode-go/glm-5.2` for its OpenCode Go complex implementation-worker mapping.

`opencode-go/glm-5.2` availability was verified before these mappings were accepted.

Audit-only findings for [`agents/yanluo.md`](../../agents/yanluo.md), [`modes/kuafu/gpt.md`](../../modes/kuafu/gpt.md), and [`modes/fuxi/gpt.md`](../../modes/fuxi/gpt.md) are not applied changes and are intentionally excluded from the accepted mapping baseline.

## Local Construction Semantics

- `mode.md`: default body. Frontmatter + body parsed. Default/unknown family uses this body unchanged.
- `gpt.md`: body-only replacement. If present and non-empty, it replaces the `mode.md` body while retaining parsed frontmatter config from `mode.md`.
- `gemini.md`: body-only overlay. If present and non-empty, it is injected into the default `mode.md` body before `<critical>`, else after `</role>`, else appended.
- Hook behavior: resolved model family is applied before prompt injection. Active mode body is wrapped in `<!-- mode:<mode> --> ... <!-- /mode:<mode> -->`; stale mode blocks are stripped before replacement.

## Current File Matrix

| Mode | Upstream Target | Default `mode.md` | GPT `gpt.md` | Gemini `gemini.md` |
|---|---|---:|---:|---:|
| Kuafu | Sisyphus | present | present | present |
| Fuxi | Prometheus | present | present | present |
| Houtu | Atlas | present | present | present |
| Luban | Superpowers skills persona/profile check | present | present | present |

## Upstream-to-Local Map

### Kuafu <- Sisyphus

Evidence:

- `sisyphus-agent-factory.ts` selects full Sisyphus prompt families by model: Kimi, GPT, Claude/Fable/Opus, GLM, fallback.
- `sisyphus/default.ts` defines senior-engineer orchestrator identity, intent gate, task/todo tracking, delegation, exploration, verification, failure recovery, and concise communication.
- `sisyphus/gpt-5-5.ts` is a complete GPT-native orchestration prompt, not a reminder fragment.
- `sisyphus/gemini.ts` is corrective Gemini guidance for tool use, delegation, intent gate, and verification.

Local invariants before edits:

- Kuafu remains Pi build mode: senior engineer/orchestrator, direct implementation only for trivial local work.
- Every family must include intent gate, explicit implementation authorization gate, scope discipline, delegation policy, continuation/supervision, and verification gates.
- GPT replacement must be self-contained; it cannot depend on missing `mode.md` body text.
- Gemini overlay must reinforce tool use, delegation, read-before-claim, and verify-before-completion without replacing the full prompt.
- Preserve Pi tool/agent mapping: `chengfeng`, `wenchang`, `taishang`, `jintong`, `yunu`, `guangguang`, pi `Task*`, `Agent`, CodeGraph, LSP, read/rg/fd, `readonly_bash`.

### Fuxi <- Prometheus

Evidence:

- `prometheus/system-prompt.ts` loads only `prometheusPromptVariants.default`; `getPrometheusPrompt()` ignores model and disabled tools.
- `docs/references/oh-my-openagent/final-prompts/prometheus/default.md` says Prometheus is a planning consultant, planner-only, writes plan artifacts under `.omo/`, never edits product code, and must load/follow `ulw-plan`. The archived upstream `ulw-plan` skill baseline lives at `docs/references/oh-my-openagent/skills/ulw-plan/`; the active Pi adaptation stays under `modes/fuxi/skills/ulw-plan/`.

Local invariants before edits:

- Fuxi remains planner-only. Product code edits and implementation are forbidden.
- Planning is sticky: user implementation verbs mean “plan this” in Fuxi.
- Only plan artifacts may be written: `local://DRAFT.md` and `local://PLAN.md`; hook restrictions remain authoritative.
- Preserve Pi planning ceremony: interview, continuous draft, Di Renjie review, final plan write, self-review, `plan_approve` gate.
- Plans for typed-code changes should include LSP diagnostics when available.
- `ask` is interview-only; final approval/proceed menus use `plan_approve`.
- GPT replacement must contain the full planner contract. Gemini overlay must not bypass draft, review, or approval requirements.

### Houtu <- Atlas

Evidence:

- `atlas/agent.ts` routes model variants through `getAtlasPromptSource()`, loads prompt bodies from `atlasPromptVariants`, and creates Atlas as master orchestrator.
- Generated Atlas final prompts live under `docs/references/oh-my-openagent/final-prompts/atlas/`. Local scope uses only `default.md`, `gpt.md`, `gemini.md`.
- Atlas prompts define conductor identity: delegate, coordinate, verify; never write code; complete every plan task; parallelize independent work; verify every delegation; update plan state only after evidence; run final verification wave.

Local invariants before edits:

- Houtu executes `local://PLAN.md` by coordinating and verifying, not by implementing product changes directly.
- One bounded plan task per `Agent()` delegation. No giant multi-task handoff.
- Independent tasks may fan out in parallel only when no named dependency or file conflict exists.
- Every delegation prompt includes task, expected outcome, required tools, must-do, must-not-do, context, and accumulated context.
- After every delegation: read changed files, run `lsp_diagnostics`, run focused tests/build when available, perform manual QA for user-visible behavior, compare claims to actual code.
- Mark checkboxes only after verification passes, then reread plan to confirm progress. Failed work resumes same subagent session when possible.
- Final wave approval remains required before completion.

### Luban <- Superpowers skills

Superpowers finding:

- Inspected `obra/superpowers` `skills/` at `896224c4b1879920ab573417e68fd51d2ccc9072`.
- No explicit top-level agent persona/profile was found in `skills/`. The tree contains skills with `name`/`description` frontmatter and workflow instructions.
- Task-specific embedded prompts exist, e.g. `requesting-code-review/code-reviewer.md`, `subagent-driven-development/implementer-prompt.md`, and reviewer prompts. These are not a global Superpowers agent profile.

Local persona/behavior source:

- Primary source: `modes/luban/skills/using-superpowers/SKILL.md` — invoke relevant skills before any response/action; 1% applicability triggers skill use; Superpowers skills override default system behavior, while user instructions remain highest priority.
- Workflow sources: `modes/luban/skills/brainstorming/SKILL.md`, `modes/luban/skills/writing-plans/SKILL.md`, `modes/luban/skills/subagent-driven-development/SKILL.md`, `modes/luban/skills/executing-plans/SKILL.md`, `modes/luban/skills/dispatching-parallel-agents/SKILL.md`, `modes/luban/skills/verification-before-completion/SKILL.md`.

Local invariants before edits:

- Luban must not claim Sisyphus/Prometheus/Atlas parity or an upstream Superpowers agent profile.
- Luban is Pi-local skill-first mode: skill gate before action, current skill text loaded, skill workflow followed exactly unless user instructions override.
- Design-to-implementation flow stays skill-driven: brainstorming -> writing-plans -> subagent-driven-development or executing-plans -> verification-before-completion.
- Preserve Pi routing: `chengfeng`, `wenchang`, `taishang`, `jintong`, `guangguang`, `yunu`, `Agent`, `Task*`, CodeGraph, `readonly_bash`. Taishang remains limited to architecture, debugging, and plan-compliance review; code-quality review uses the orchestrator-owned code-quality gate.
- Parallelism is safety-gated, not maximized. Implementation parallelism needs independent scope and conflict plan.
- GPT replacement must be self-contained. Gemini overlay must reinforce skill loading, tool use, and verification only.

## Non-Goals

- No model families beyond local default/GPT/Gemini.
- No model-chain, provider, auth, or registry changes beyond accepted mappings recorded above.
- No wholesale upstream prompt clone.
- No exact-copy claim. Target final injected behavior parity where applicable, with Pi-native tools and constraints.
- Audit-only proposals remain unapplied until separately approved.
