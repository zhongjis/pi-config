# 6. Kua Fu's finish gate uses two isolated review axes

Status: shipped
Date: 2026-10-12
Related: [../../modes/kuafu/skills/gate-review/SKILL.md](../../modes/kuafu/skills/gate-review/SKILL.md) · [../../modes/kuafu/mode.md](../../modes/kuafu/mode.md) · [../../extensions/ulw/prompts/default.md](../../extensions/ulw/prompts/default.md) · [0001-orchestration-sizing-follows-upstream-omo.md](0001-orchestration-sizing-follows-upstream-omo.md)

## Context

Kua Fu reviewed its own finished work: the orchestrator owned code-quality review, and the prompts forbade spawning a reviewer. The orchestrator that wrote or supervised a change is a weak judge of whether it built the right thing.

Upstream omo adds a finish gate in two shapes. Atlas runs four parallel final-wave reviewers after a plan (plan compliance, code quality, real manual QA, ideal-state fidelity). Sisyphus and ultrawork use the `review-work` skill: the orchestrator runs manual QA, then exactly one gate reviewer (`oracle`) audits goal, constraints, and QA evidence. Its rule is "one reviewer, not a panel".

Matt Pocock's `code-review` skill splits review into two axes run in separate agents: **Spec** (does the change implement what was asked) and **Standards** (does it follow the repository's documented standards plus a fixed baseline of code smells). The axes are reported side by side so one cannot mask the other.

An A/B eval of the GPT prompts showed the cost side: a reviewer pair on a small change cost about $0.5-0.8 and several minutes and found nothing blocking.

## Decision

1. **Two axes, two existing agents.** The finish gate is the [gate-review](../../modes/kuafu/skills/gate-review/SKILL.md) skill. `direnjie` reviews Spec and `taishang` reviews Standards, in parallel, each reading the axis instructions in [reviewer.md](../../modes/kuafu/skills/gate-review/reviewer.md). No new agent is added; each gains a short diff-review paragraph.
2. **Manual QA first.** The orchestrator runs manual QA before the gate; a QA failure is fixed before any review.
3. **Blocking rule from upstream.** A finding blocks only when it cites a requirement, acceptance criterion, scenario, or documented standard that the change fails; baseline smells never block. At most two re-reviews, then remaining blockers go to the user.
4. **Narrow trigger.** Plain Kua Fu runs the gate when the user asks or for refactors, migrations, and security changes. Ultrawork also runs it when a change alters behavior in 3+ source files; docs, tests, and config do not count, and research, docs-only, and prototype work skip it.
5. **Acceptance stays with the orchestrator.** Reviewers advise; the orchestrator still reads the diff and owns final acceptance.

Two isolated axes were chosen over upstream's single gate reviewer because a single reviewer can let a clean-code impression mask a spec miss, and the reverse. Upstream's four-reviewer wave was rejected as too costly for Kua Fu's mostly small tasks.

## Consequences

- Each gated change costs two extra agent runs on the reviewers' model chains.
- Kua Fu now owns a mode skill directory, so switching modes into or out of Kua Fu reloads mode-owned skill resources.
- Subagents cannot preload mode-owned skills, so the orchestrator hands each reviewer the path to `reviewer.md` instead.
