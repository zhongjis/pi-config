# modes

## Purpose

Mode prompt definitions and model-family prompt variants for Kua Fu, Fu Xi, Hou Tu, Lu Ban, and Shen Nong.

## Ownership

This file owns `modes/` prompt files and mode subdirectories.

## Local Contracts

- `mode.md` carries canonical frontmatter plus default prompt body.
- `gpt.md` is a body-only replacement; it inherits `mode.md` frontmatter and must be self-contained. When a mode ships no `gpt.md`, its GPT family inherits the default `mode.md` body.
- `gemini.md` is a body-only corrective overlay on the default prompt body.
- Keep the per-mode `mode.md` + `gemini.md` pair complete for every mode, and ship `gpt.md` for every mode except Fu Xi, whose GPT family intentionally inherits the default `mode.md` body. Removing a mode family is the only other reason the matrix may be incomplete.
- `<mode>/skills/*/SKILL.md` (optional): mode-owned skills discovered only while that mode is active. Full skill content remains on-demand; no mode skill is eagerly injected. References resolve relative to the skill base dir supplied at runtime.
- Fu Xi is a thin Prometheus prompt family. `modes/fuxi/mode.md` and `gemini.md` require loading `modes/fuxi/skills/ulw-plan/SKILL.md` before planning (Fu Xi ships no `gpt.md`; GPT runs inherit the default body). The mode-owned skill preserves the pinned upstream `v4.19.0` plan format, routing, task grammar, scaffold semantics, and guidance with only Pi runtime adaptations; do not duplicate workflow text in mode prompts.
- Oh My OpenAgent reference archive contains generated final prompts only under `docs/references/oh-my-openagent/final-prompts/`; refresh with `pnpm sync:oh-my-openagent-prompts`, verify with `pnpm check:oh-my-openagent-prompts`, and never hand-edit generated files.
- Lu Ban owns the 14-skill Superpowers snapshot under `modes/luban/skills/`; `UPSTREAM.md` and `LICENSE` preserve provenance. Runtime discovery is Lu Ban-only and full content remains on-demand.
- Kuafu delegates turn-local tactical planning to callable `xuannv`; keep that advisory text-return flow separate from Fu Xi mode’s durable planning ceremony.
- Kuafu default/GPT prompts keep P0/P1 control parity: precise Taishang triggers and anti-triggers, explicit user-requested consultations, blocking consultation dependencies, consult-before-third failure recovery with ownership-safe last-green restoration, bounded exploration retries/stops, pattern-maturity checks, hard invariants, and a final request/intent drift check.
- Preserve locked family anchors in prompt variants (`mode.md`, `gpt.md`, `gemini.md`) and keep prompt audits focused on the final injected session prompt, including the final injected session audit requirement.
- When mode prompts mention code intelligence, preserve the split: CodeGraph for broad structure/impact, LSP for symbol-precise facts and diagnostics, and `rg`/`fd` for literal/file search.
- For orchestration modes, keep delegation chunks worker-sized: one domain, one deliverable, sized to one worker session; split state/API/UI/tests/docs/git by domain or coupling, not by a fixed file count. A plan item too large for one session runs as one resumable worker session (staging, a green checkpoint, a tool-call ceiling, and a fail-safe — stop at last green state, report a resume anchor, never leave the tree broken) resumed in place with `Agent(resume)`, never carved into separate delegations. Workers stop and ask only when a task is genuinely ambiguous; they never reject on file count.
- Frontend/web UI implementation, styling, layout, components, and visual behavior route to `yunu` (implementation only); visual/browser QA stays with the orchestrator's Manual QA Gate (drive the surface yourself via look_at / webapp-testing / agent-browser), never delegated to `yunu`. Keep `jintong` as the standard non-UI implementation/debug/test worker and `juling` as the opus-tier worker for complex/higher-risk implementation.
- Code-quality review (build/lint/typecheck/tests + diff-vs-requirements) is an `orchestrator-owned code-quality gate`; `taishang` is architecture/debugging consult + F1 plan-compliance audit only, NEVER code-quality review (realigned to omo's Oracle, which does not review code).
- Hou Tu executes approved `PLAN.md` paths supplied by `/handoff:start-work` through `buildPlanExecutionGoal(planPath)`, with strict tracking/agent lifecycle separation.
- Hou Tu MUST batch-create pending top-level Todos plus F1-F4 through `Task op:create`, wire `addBlockedBy` dependencies, mark `in_progress` before dispatch, and mark `completed` plus check PLAN only after parent verification. PLAN is the durable source of truth; Task is its synchronized runtime mirror.
- Independent implementation MUST launch as multiple foreground `Agent` calls in one assistant response. They execute concurrently while Hou Tu blocks until all return. Background runs are only for non-blocking exploration/research; runtime Agent IDs stay in active session memory, NEVER Task metadata, PLAN, or notepads.
- Parent MUST initialize and curate `local://{plan-name}/notepads/` with `learnings.md`, `decisions.md`, `issues.md`, and `blockers.md`.
- All workers MUST read only relevant shared notes.
- Mutation-capable workers MUST append only relevant findings and preserve unrelated entries.
- Read-only researchers MUST return findings to parent for curation.
- Every worker prompt MUST retain exactly six top-level sections and place capability-aware shared-note instructions under CONTEXT.
- Notepad entries remain worker claims until parent verification. Parent MUST reread relevant notes before treating them as durable orchestration wisdom.
- Shared Agent-tree storage is same-user collaboration, not sandbox or security isolation.
- Hou Tu MUST delegate product-code, test-file, documentation, and git mutations. Parent retains verification plus PLAN, Task, and notepad orchestration-state mutations.
- Hou Tu MUST use `Agent(resume)` for salvageable workstreams. A fresh session is allowed only when its predecessor is unavailable or unsalvageable and MUST receive failure context. Hou Tu MUST consult `taishang` before attempt 3. Each delegation remains one domain + one deliverable.
- Final-wave ownership is fixed: F1 `taishang`; F2 parent code-quality gate; F3 parent manual QA; F4 `direnjie`. Rejection leaves the gate `in_progress` and unchecked, repairs the responsible implementation workstream, then reruns every invalidated gate. Hou Tu MUST surface all four approvals and wait for explicit user okay before declaring complete.
- Fu Xi emits a per-task `Recommended Max Turns` advisory. Hou Tu uses it when sizing foreground `Agent` runs and may raise it; Hou Tu selects workers by runtime task-domain fit, then evaluates all available skills. Planned ownership is not binding.
- Delegation frontmatter is canonically parsed into a versioned policy snapshot persisted in `agent-mode` state. `subagent` consumes that snapshot as authorization authority for direct `Agent` and RPC requests; modes hooks retain non-`Agent` guards only, while static `Agent` guidance stays generic and non-stale.

## Work Guidance

- Change the narrowest prompt variant that matches the target model family.
- Preserve frontmatter in `mode.md` unless changing runtime mode registration.
- Keep model-family overrides aligned in intent, even when wording differs.
- Use `docs/specs/mode-prompt-audit-checklist.md` for broad prompt audits.

## Verification

- Re-read the final edited prompt variant and its corresponding `mode.md`.
- For runtime-sensitive changes, run the relevant integration coverage from root with `pnpm test:integration` or the focused mode integration test when available.

## Child DOX Index

| Path | Owner Doc | Scope |
|------|-----------|-------|
| `fuxi/` | this file | Fu Xi planning mode prompt variants. |
| `houtu/` | this file | Hou Tu execution mode prompt variants. |
| `kuafu/` | this file | Kua Fu build-orchestrator mode prompt variants. |
| `luban/` | this file | Lu Ban prompt variants, mode-owned Superpowers skill snapshot, and provenance. |
| `shennong/` | this file | Shen Nong product-manager mode prompt variants. |
