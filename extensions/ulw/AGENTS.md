## Purpose

Inject the opt-in ultrawork prompt in Kua Fu mode when a message contains a bare `ultrawork` or `ulw` token.

## Ownership

- Owns keyword detection, model-family prompt selection, prompt variants, the activation banner, and tests.
- [README](README.md) owns upstream adaptation; [index.ts](index.ts) owns hooks.

## Local Contracts

- Explicit activation MUST require a bare `ulw` or `ultrawork` token anywhere in input, case-insensitive, bounded by whitespace or start/end. Task-prefixed and mid-message tokens activate; quoted, path, and punctuation-attached tokens do not. Preserve code/prompt/`@` reference sanitation, kuafu gating, pending-flag consumption, and separate custom-message injection; task-bearing user text remains unchanged.

- Both variants MUST share behavior. [default](prompts/default.md) is canonical; [GPT](prompts/gpt.md) restates it in GPT style ([parity rule](../../modes/MODEL-FAMILIES.md#parity-rule)). A behavior change lands in both.
- Both variants MUST contain only what ULW adds on top of the Kua Fu body: persistence, a light notepad (Plan, Now, Findings), a done contract (scenarios sized to the change plus one WHEN TO STOP line), the testing rules, real-surface manual QA, the commit authorization (`git-master`, never push), the [gate-review](../../modes/kuafu/skills/gate-review/SKILL.md) finish gate, and stop rules. They MUST NOT restate delegation, scope, verification, or output rules the mode body owns, and MUST NOT require planner calls.
- Both variants MUST stop redundant work once useful evidence satisfies the request, without waiving required final-state checks, manual QA, or approval/handoff gates.
- Both variants MUST respect research-only, review-only, and proposal-only scope and planner approval/handoff gates; ULW adds rigor, not authority.
- Both variants MUST derive scenarios from the agreed task as evidence, not redefine its outcomes, and size them at 1-2 for small single-surface work and 3+ for risky or multi-surface work; completion requires fulfilling agreed outcomes and constraints with supporting evidence, not passing checks alone.
- Both variants MUST read covering tests before changes, reproduce bugs before fixing, compare refactor results before and after the change, and add tests only where repository convention keeps them and regressions would otherwise go unnoticed. Prototypes, spikes, docs, prompts, and visual-only changes get no new tests. Required repository gates and manual QA for runnable changed user surfaces remain binding.
- You MUST review prompt prose rather than assert it; tests MAY protect machine-consumed contracts with synthetic mechanism fixtures, NEVER pin live repository data. Reuse evidence until relevant changes invalidate it.

- Accepted activation MUST emit one session-scoped `ulw:activated` signal; ULW NEVER reads or mutates Goal state. Goal owns the separate hidden bootstrap and lifecycle. Session switching MUST discard pending injection.

## Work Guidance

- Fidelity review and UI QA policy live in the Kua Fu body's UI work and verification sections ([mode.md](../../modes/kuafu/mode.md), [gpt.md](../../modes/kuafu/gpt.md)); the ULW manual-QA table only names the real surface per change type.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/ulw`.

## Child DOX Index

- None; this document owns the entire subtree.
