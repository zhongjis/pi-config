# Lu Ban Workflow Validation Design

## Goal

Tune Lu Ban mode so it keeps the Superpowers design discipline without validating every small step through heavy subagent review.

The workflow should optimize for fast progress by default. It should still stop for user intent when intent is unclear, and it should still use agent review when a change is risky or reaches an integration checkpoint.

## Non-goals

- Do not change Superpowers skill files.
- Do not remove the brainstorming or writing-plans gates.
- Do not make user approval a routine implementation checkpoint.
- Do not broaden this into a new agent framework.

## Decision

Use risk-gated validation.

User validation owns product intent: goal, scope, success criteria, and meaningful design changes. Agent validation owns execution quality: plan clarity, implementation correctness, verification evidence, and final readiness.

Routine low-risk tasks should not require both Taishang and Wei Zheng. High-risk work and final checkpoints should use Wei Zheng as the main code-readiness validator. Taishang remains the reasoning validator for spec, architecture, and ambiguity.

## Risk Classes

A task is **low-risk** when all of these are true:

- The change is localized and small.
- It does not change a public API or event contract.
- It does not touch auth, security, persistence, migrations, or data-loss paths.
- It does not sit in a flaky or already-failing test area.
- It does not require multiple implementation agents editing related files.

A task is **high-risk** when any of these are true:

- It edits multiple files in a coupled path.
- It changes a public API or event contract.
- It touches auth, security, persistence, migrations, or data-loss behavior.
- It touches flaky tests or already-failing areas.
- It crosses subsystem boundaries.

If risk is unclear, treat the task as high-risk until the controller can classify it from code, plan, or validator evidence.

## Planning Validation

Planning keeps the existing Superpowers order:

1. Brainstorming explores context and writes a design spec.
2. The user approves product intent, scope, and success criteria.
3. Writing-plans creates an implementation plan.
4. The controller validates the plan before execution.

The controller should ask the user only when intent-level information is missing. Examples include unclear goals, missing success criteria, scope that needs decomposition, or a high-risk expansion beyond the approved spec.

Taishang may review the design or plan when ambiguity remains after reading the spec and code. Taishang should decide whether the issue is technical or intent-level. Technical issues stay inside the agent loop. Intent-level issues go back to the user as one focused question.

Plan validation is lightweight by default. Each task should name its input, expected output, likely files or subsystem, and verification command. Full plan review is needed only when the plan contains high-risk tasks or unclear architecture.

## Execution Validation

### Low-risk tasks

Low-risk tasks use implementer self-checks:

- Read back changed files or relevant diffs.
- Run focused tests, typecheck, or lint when available.
- Summarize what changed and what verification passed.

The controller reviews the result for vague claims, unexpected files, missing verification, or behavior outside the approved scope. If any appear, the controller may escalate to Taishang or Wei Zheng.

### High-risk tasks

High-risk tasks use stronger validation:

- Before implementation, use Taishang only when spec, architecture, or intent is unclear.
- After implementation, use Wei Zheng as the main validator.
- If Wei Zheng rejects the change, send the finding back to the implementer and re-review only the changed task.

Do not run Taishang and Wei Zheng by default for the same task. Use both only when the task needs both reasoning review and code-readiness review.

### Milestones

Run a milestone checkpoint when work crosses a contract boundary, combines multiple tasks, enters a flaky area, or reaches final completion.

A milestone checkpoint should run focused integration checks. Use Wei Zheng when code changed and a ship/no-ship verdict is useful. Use Taishang only when behavior or spec alignment is uncertain.

### Final checkpoint

Before claiming completion, always run the applicable focused verification: tests, typecheck, lint, or project-specific commands.

Use Wei Zheng for the final review unless the work is docs-only and has no code behavior change.


## User Escalation Rules

Ask the user when:

- Global goal or intent is unclear.
- Success criteria are missing.
- Scope needs decomposition.
- A high-risk change expands beyond the approved spec.
- A validator finds ambiguity that cannot be resolved from code or spec.
- An irreversible or destructive action is needed.

Do not ask the user for:

- Routine task validation.
- Standard test, lint, or typecheck choices when repo convention exists.
- Technical fixes inside approved scope.
- Low-risk implementation details.
- Permission to run standard non-destructive checks.

## Agent Roles

- **Taishang** validates reasoning: architecture, spec alignment, ambiguity, and blast-radius analysis.
- **Wei Zheng** validates code readiness: diff review, build, lint, typecheck, tests, and final verdict.
- **Implementers** own local self-checks for low-risk work.
- **Controller** classifies risk, chooses checkpoints, routes validators, and summarizes evidence.
- **User** owns intent and scope.

## Minimal Repo Changes

Update `agents/luban.md` to:

- Add risk-gated validation policy.
- Replace routine two-reviewer validation with conditional Taishang and Wei Zheng use.
- Define low-risk, high-risk, milestone, and final checkpoint behavior.
- Add user escalation rules.

Update `docs/modes.md` to keep the Lu Ban mode summary aligned with the new behavior.

No skill files should change.

## Success Criteria

- Lu Ban no longer requires Taishang and Wei Zheng for every implementation task.
- Low-risk work can complete with implementer self-checks and focused verification.
- High-risk work still gets Wei Zheng review after implementation.
- Taishang is used for ambiguity and architecture, not routine readiness.
- User questions are limited to intent, scope, success criteria, meaningful design changes, and destructive actions.
- Final completion still requires evidence from focused verification.
