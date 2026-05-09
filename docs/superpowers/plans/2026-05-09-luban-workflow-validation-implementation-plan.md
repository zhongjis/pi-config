# Lu Ban Workflow Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update Lu Ban mode docs and prompt so validation is risk-gated instead of always using two heavy reviewers.

**Architecture:** This is a prompt/documentation change only. `agents/luban.md` owns live mode behavior; `docs/modes.md` records the mode contract for maintainers. No Superpowers skill files or runtime extension code change.

**Tech Stack:** Markdown agent prompts and repository documentation.

---

## File Structure

- Modify `agents/luban.md` to define risk-gated validation, validator roles, user escalation rules, and best-effort GitNexus change detection.
- Modify `docs/modes.md` to document Lu Ban behavior at a high level.
- Do not edit files under `extensions/superpowers/skills/`.

## Risk Classification

This plan is low-risk:

- It changes two Markdown files.
- It does not change runtime TypeScript, public API, event contracts, auth, persistence, migrations, or data-loss behavior.
- It has no required automated test suite beyond markdown readback and diff review.

## Task 1: Update Lu Ban mode prompt

**Files:**
- Modify: `agents/luban.md`

- [ ] **Step 1: Replace routine two-reviewer language**

In `agents/luban.md`, change the Superpowers workflow line for execution from routine `spec-review, quality-review, loop until approved` to risk-gated validation.

Target text:

```markdown
3. **subagent-driven-development** — execute with risk-gated validation: low-risk tasks use implementer self-checks and focused verification; high-risk tasks and checkpoints use the appropriate reviewer
```

- [ ] **Step 2: Update agent routing table**

Replace the reviewer rows with validator-specific language:

```markdown
| Reasoning / spec validator | `taishang` | architecture decisions, design trade-offs, ambiguity, spec alignment, blast-radius reasoning |
| Code readiness validator | `weizheng` | high-risk task review, milestone review when code changed, final ship/no-ship review |
```

- [ ] **Step 3: Add validation policy after implementer selection**

Insert this section after the implementer selection paragraph:

```markdown
## Risk-gated validation

Default optimization: move fast with evidence. Do not run heavyweight review for every small task.

**Low-risk task:** all true — localized/small diff, no public API or event contract change, no auth/security/persistence/migration/data-loss path, no flaky or already-failing test area, no coupled multi-agent edit. Validate with implementer self-check: readback or diff summary, focused tests/typecheck/lint when available, and concrete verification output. Controller spot-checks for vague claims, unexpected files, missing verification, or scope drift.

**High-risk task:** any true — coupled multi-file path, public API or event contract change, auth/security/persistence/migration/data-loss behavior, flaky or already-failing area, subsystem boundary crossing. Use `weizheng` after implementation as the main code-readiness validator. Use `taishang` only when spec, architecture, blast radius, or intent alignment is uncertain.

**Milestone checkpoint:** run when work crosses a contract boundary, combines multiple tasks, enters a flaky area, or reaches final completion. Run focused integration checks. Use `weizheng` when code changed and a ship/no-ship verdict is useful. Use `taishang` only for unresolved reasoning/spec questions.

**Final checkpoint:** before claiming completion, run applicable focused verification. Use `weizheng` unless the work is docs-only with no code behavior change. Run `gitnexus_detect_changes()` as best effort only; if GitNexus is stale, unavailable, or failing, record the skip reason and do not block completion.
```

- [ ] **Step 4: Add user escalation policy**

Insert this section near execution stance or after risk-gated validation:

```markdown
## User escalation

Ask the user only when product intent is missing or execution would exceed approved intent:

- global goal, scope, or success criteria unclear
- scope needs decomposition
- high-risk change expands beyond approved spec
- validator finds ambiguity that cannot be resolved from code or spec
- irreversible or destructive action needed

Do not ask the user for routine task validation, standard non-destructive checks, repo-conventional test commands, technical fixes inside approved scope, or low-risk implementation details.
```

- [ ] **Step 5: Read back `agents/luban.md`**

Run:

```bash
rg -n "risk-gated|Low-risk|High-risk|Final checkpoint|User escalation|gitnexus_detect_changes|Reasoning / spec validator|Code readiness validator" agents/luban.md
```

Expected: matches for each new policy and updated routing row.

## Task 2: Update modes documentation

**Files:**
- Modify: `docs/modes.md`

- [ ] **Step 1: Expand Lu Ban mode summary**

Add a short Lu Ban section after the modes table:

```markdown
### Lu Ban Validation Policy

Lu Ban follows Superpowers skill gates, then validates implementation by risk. Low-risk work uses implementer self-checks plus focused verification. High-risk work uses Wei Zheng for code-readiness review after implementation, and Taishang only when spec, architecture, blast radius, or intent alignment is uncertain.

User approval is reserved for product intent: unclear goals, missing success criteria, scope decomposition, high-risk expansion beyond the approved spec, unresolved ambiguity, or destructive actions. Routine technical validation stays inside the agent loop.

`gitnexus_detect_changes()` is best effort for Lu Ban final checkpoints. A stale or unavailable GitNexus index should be recorded, not treated as a blocker.
```

- [ ] **Step 2: Read back `docs/modes.md`**

Run:

```bash
rg -n "Lu Ban Validation Policy|risk|Wei Zheng|Taishang|gitnexus_detect_changes" docs/modes.md
```

Expected: the new section appears once and matches the prompt policy.

## Task 3: Final verification and commit

**Files:**
- Modify: `agents/luban.md`
- Modify: `docs/modes.md`
- Already present: `docs/superpowers/specs/2026-05-09-luban-workflow-design.md`
- This plan: `docs/superpowers/plans/2026-05-09-luban-workflow-validation-implementation-plan.md`

- [ ] **Step 1: Review diff**

Run:

```bash
git diff -- agents/luban.md docs/modes.md docs/superpowers/plans/2026-05-09-luban-workflow-validation-implementation-plan.md
```

Expected: only planned Markdown files changed.

- [ ] **Step 2: Search for stale old reviewer wording**

Run:

```bash
rg -n "spec-review, quality-review|after spec compliance passes|after implementer completes" agents/luban.md docs/modes.md
```

Expected: no matches in `agents/luban.md` or `docs/modes.md` except if quoted in unrelated historical docs. If a stale match remains in the edited files, update it.

- [ ] **Step 3: Commit atomically**

Run:

```bash
git add agents/luban.md docs/modes.md docs/superpowers/plans/2026-05-09-luban-workflow-validation-implementation-plan.md
git commit -m "docs(luban): add risk-gated validation workflow"
```

Expected: commit succeeds.
