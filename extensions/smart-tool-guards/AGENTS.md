## Purpose

Authorize selected native bash calls through deterministic policy and model classification.

## Ownership

- Owns scope evaluation, read-only policy, classifier validation, and denial formatting.
- Scope providers identify guarded callers; Pi retains native bash execution.

## Local Contracts

- Guarded execution MUST fail closed on scope, input, or exhausted-classifier failures.
- Non-bash tools and abstaining callers MUST retain native behavior.
- Allowed calls MUST preserve command, cwd, timeout, and native execution semantics.
- Policy and classifier MUST evaluate the model-issued command recorded at assistant `message_end`; other extensions' `tool_call` mutations are trusted and not re-evaluated.
- Trusted policy MUST remain separate from untrusted command/context JSON.
- Classifier verdicts MUST match the exact allow/block schema.
- Denials MUST retain the stable envelope without raw provider errors and identify the current agent's capability restriction and non-execution, not a project-wide lack of access.
- [Lark policy](src/bash-policy.ts) MUST allow only exact direct literal document search/fetch and discovery forms after shell danger checks; other recognized Lark calls, including path and known-wrapper variants, MUST block without classifier fallback. Verified flags and required read selectors are code-owned.
- [Literal inspection](src/literal-inspection.ts) MUST run only after full danger checks and approve only direct, literal argv with every pipeline stage validated. Unknown options, wrappers, expansions, and general compound commands MUST defer or block; command discovery has one exact fallback exception.
- [Diagnostic inspection](src/diagnostic-inspection.ts) MUST fast-approve only validated direct no-pager journal/service reads and fixed SQLite schema inspection with disabled initialization and an immutable read-only snapshot URI. Immutable inspection is for offline snapshots, not live WAL evidence; unsupported argv MUST NOT gain fast approval.
- [Shell scanning](src/bash-syntax.ts) MUST distinguish exact stderr-to-stdout descriptor duplication from file output while retaining independent danger checks. This does not authorize arbitrary pipeline stages or sed programs.
- Classifier policy MUST assess exact effects rather than treating executables, outside-repository reads, or shell composition as mutations; uncertain effects MUST block. Other safety restrictions remain in force.
- This authorization guard is not a shell sandbox; allowed commands retain native power.

## Work Guidance

- [README](README.md) owns caller scope, policy precedence, verdict grammar, and model fallback behavior.
- Cancellation and classifier deadlines MUST remain independent of native execution timeout.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/smart-tool-guards/test`.
- [Policy](test/bash-policy.test.ts), [classifier](test/classifier.test.ts), and [wiring](test/index.test.ts) cover distinct trust boundaries.

## Child DOX Index

- None; this document owns the entire subtree.
