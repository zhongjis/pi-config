## Purpose

Shared test harness, smoke coverage, fixtures, stubs, and runtime integration tests.

## Ownership

- This document owns root tests, `fixtures/`, `stubs/`, `types/`, and shared setup.
- The integration child owns real-runtime tests and their helpers.
- Extension-specific unit tests belong beside their extension, not here.
- [../vitest.config.ts](../vitest.config.ts) owns project selection and aliases.
- `deep-research-workflow.test.ts` and `last30days-workflow.test.ts` execute saved workflow sources through the real runtime with fixture agents, covering explicit outcomes and dependent-stage failure handling.
- `install-workflows.test.ts` exercises real installer workflow-link handling inside isolated fixture repositories and temporary homes.

## Local Contracts

- You MUST follow the [testing guide](../docs/guides/testing/README.md).
- Unit tests use local Pi stubs; integration tests use real packages.
- Repository testing infrastructure stays outside runtime installation.
- Smoke coverage checks loading and registration, not behavioral correctness.

## Work Guidance

- You MUST follow [unit conventions](../docs/guides/testing/unit-test.md) for shared unit coverage.
- You SHOULD keep smoke tests cheap and behavioral assertions focused.
- You MUST add stub capabilities to the appropriate existing module.

## Verification

- Unit project: `pnpm test:extensions`.
- Focused saved-workflow and installer tests: `pnpm exec vitest run --project unit test/deep-research-workflow.test.ts test/install-workflows.test.ts`.
- Real-runtime project: `pnpm test:integration`.

## Child DOX Index

- [integration/AGENTS.md](integration/AGENTS.md) — real Pi sessions, boundaries, and cleanup.
