## Purpose

Integration coverage exercising extensions inside the real Pi runtime.

## Ownership

- This document owns all integration tests and [helpers/](helpers/).
- [../../vitest.config.ts](../../vitest.config.ts) owns the integration project and timeout.
- Parent-owned stubs and fixtures support unit tests, not replacement runtime internals.

## Local Contracts

- You MUST follow the [integration guide](../../docs/guides/testing/integration-test.md).
- Integration tests use real Pi packages, without unit-project stub aliases.
- Playbooks replace model output; optional mocks intercept tools and UI boundaries.
- You MUST retain real extension registration, hooks, and session behavior.
- In-process harness sessions do not test actual process-switch boundaries.

## Work Guidance

- You MUST dispose test sessions in cleanup, including failed assertions.
- You SHOULD assert event traces and observable outcomes.
- You MUST provide discoverable agent configuration when a scenario requires it.
- You MUST test boundary logic without claiming cross-process coverage.

## Verification

- Integration project: `pnpm test:integration`.
- Focused mode coverage: `pnpm exec vitest run --project integration test/integration/modes.integration.test.ts`.
- Project timeout is 30 seconds, as configured in Vitest.

## Child DOX Index

- None; this document owns every integration scenario and helper.
