## Purpose

Expose native indexed-code tools backed by the local CodeGraph MCP subprocess.

## Ownership

- Owns tool schemas, project-root resolution, subprocess requests, and serialization.
- The external CodeGraph CLI owns indexing; this adapter adds no root MCP configuration.

## Local Contracts

- `codegraph_status` MUST remain inspect-only: no initialization or project mutation.
- Automatic initialization MUST require a valid project marker and a non-status query.
- Root discovery MUST remain bounded by the containing git/worktree root.
- Same-project calls MUST serialize; unrelated project queues remain independent.
- Timeouts MUST kill hung subprocesses; retries retain the [documented limits](README.md#configuration--requirements).

## Work Guidance

- [README provenance](README.md#provenance) records the base vendor and absorbed/local changes; this is not a single-upstream fork.
- You MUST preserve [LICENSE](LICENSE) and the recorded origins when syncing.
- [README](README.md) owns tool/configuration details; NEVER add engine dependencies to fix adapter documentation.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/codegraph/test/index.test.ts`.
- Existing tests cover marker gating, status, queueing, and subprocess failure behavior.

## Child DOX Index

- None; this document owns the entire subtree.
