## Purpose

Provide shared extension utilities and integration primitives.

## Ownership

- Owns the flat utility modules, barrel exports, and local tests.
- Callers retain extension-specific lifecycle and state ownership.

## Local Contracts

- `initLib(pi)` wires debug support idempotently across callers.
- The default discovery entrypoint MUST remain a no-op; consumers initialize explicitly.
- Utilities include clipboard I/O, logging, caches, and stream wrappers; not all helpers are pure.
- RPC requests MUST carry `requestId`; replies use `{ success: true, data? }` or `{ success: false, error: string }`.
- Temporary RPC reply listeners MUST unsubscribe on settlement or timeout.
- Model chains parse terminal `:fast` after an optional thinking suffix; absent fast metadata retains the legacy object shape and means off to consumers.
- `fast.ts` owns stateless eligibility, transforms, and branch-policy reading; preserve [helper contracts](README.md#fast-request-helpers). Callers MUST validate explicit on before strict application; NEVER mutate shared models.
- Fast allowlist changes require official provider evidence for exact public model IDs, matching regression tests, and updated [support documentation and sources](README.md#fast-request-helpers); no inferred aliases, wildcards, or internal models.

## Work Guidance

- You SHOULD reuse [existing modules](README.md#modules) before adding utilities.
- Shared public utilities MUST be re-exported through [index.ts](index.ts).
- You MUST keep extension-specific state outside this shared library.

## Verification

- From repository root: `pnpm exec vitest run --project unit extensions/lib/test`.
- [RPC tests](test/rpc.test.ts) cover envelopes and listener lifecycle.

## Child DOX Index

- None; this document owns the entire subtree.
