## Purpose

Authorize selected native bash calls through deterministic policy and model classification.

## Ownership

- Owns scope evaluation, read-only policy, classifier validation, and denial formatting.
- Scope providers identify guarded callers; Pi retains native bash execution.

## Local Contracts

- Guarded execution MUST fail closed on scope, input, or exhausted-classifier failures.
- Non-bash tools and abstaining callers MUST retain native behavior.
- Allowed calls MUST preserve command, cwd, timeout, and native execution semantics.
- Trusted policy MUST remain separate from untrusted command/context JSON.
- Classifier verdicts MUST match the exact allow/block schema.
- Denials MUST retain the stable envelope without raw provider errors.
- This authorization guard is not a shell sandbox; allowed commands retain native power.

## Work Guidance

- [README](README.md) owns caller scope, policy precedence, verdict grammar, and model fallback behavior.
- Cancellation and classifier deadlines MUST remain independent of native execution timeout.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/smart-tool-guards/test`.
- [Policy](test/bash-policy.test.ts), [classifier](test/classifier.test.ts), and [wiring](test/index.test.ts) cover distinct trust boundaries.

## Child DOX Index

- None; this document owns the entire subtree.
