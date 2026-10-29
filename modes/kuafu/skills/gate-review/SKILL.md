---
name: gate-review
description: Finish-gate code review for Kua Fu. Runs the Spec reviewer (direnjie) and the Standards reviewer (taishang) in parallel on a finished change, then acts on their verdicts. Use at the finish gate, after manual QA passes.
---

# Gate review

Two-axis review of a finished change, adapted from Matt Pocock's `code-review` skill:

- **Spec**: does the change do what was agreed? Reviewer: `direnjie`.
- **Standards**: does the change follow this repo's documented standards? Reviewer: `taishang`.

Each axis runs in its own agent so one axis cannot mask the other. A change can pass one axis and fail the other: code that follows every standard but implements the wrong thing, or code that does exactly what was asked but breaks the project's conventions.

## When

- Ultrawork: when the change alters behavior in 3+ source files (docs, tests, and config do not count), or is a refactor, migration, performance, or security change. Smaller changes, research, docs-only, and prototype work skip it.
- Otherwise: when the user asks, or for refactors, migrations, and security changes.

Manual QA comes first. If QA fails, fix it before review; reviewing code that does not work wastes the reviewers.

Before launching reviewers, establish passing evidence for applicable repository type checks and authored-file size gates across all changed source, test and documentation files. Staged-only gates must include every intended file. Resolve failures and required splits before review. Reuse passing evidence that still covers the final diff; do not rerun checks merely for this gate.

## Steps

1. **Pin the base**: the commit where the task started. The diff command is `git diff <base>`, which covers commits and uncommitted edits; run `git add -N` on new files first so they show up. Confirm the diff is non-empty.
2. **Spec**: the agreed task, its acceptance criteria, the ultrawork scenarios, and the user's decisions, quoted as given. Look up an issue only if the task names one.
3. **Standards sources**: every file that documents how code is written here: the `AGENTS.md` chain for the changed paths, `CODING_STANDARDS.md` or `CONTRIBUTING.md` when present, and the skills whose rules apply (for example `programming`).
4. **Launch both reviewers in one response**, in the background:
   - `direnjie` packet: `AXIS: spec`, `REVIEWER FILE: <this skill's directory>/reviewer.md`, the diff command, the spec text, and a summary of the manual QA evidence.
   - `taishang` packet: `AXIS: standards`, `REVIEWER FILE: <this skill's directory>/reviewer.md`, the diff command, and the standards source list.
   Use the delegation packet's `CONTEXT` and `MUST NOT DO` fields for supplied evidence, research already assigned, unresolved gaps, and deliberate exclusions. State that read-only permits `delegate_research` under the explore rules for remaining gaps; each reviewer retains required personal full-diff inspection and its verdict.
5. **Collect both.** Present them under `## Spec` and `## Standards`, verbatim or lightly cleaned. Do not merge or rerank findings across axes. End with one line: findings per axis and the worst issue within each axis.
6. **Fix every blocker.** Notes do not block. Resume the same reviewer session with the new diff for re-review, at most 2 times.
7. **Escalate**: if blockers remain after 2 re-reviews, surface them to the user before declaring done.

The reviewers advise; you own final acceptance.
