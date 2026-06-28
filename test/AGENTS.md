# test

## Purpose

Root Vitest smoke, shared unit tests, integration tests, fixtures, and Pi package stubs.

## Ownership

This file owns `test/`. Extension-local tests remain owned by their extension directory.

## Local Contracts

- Unit tests use stubs from `test/stubs/` and fixtures from `test/fixtures/`.
- Integration tests under `test/integration/` use the real Pi runtime through `pi-test-harness`.
- Root smoke coverage is centralized in `test/extensions.smoke.test.ts`.
- Do not delete or skip failing tests to pass checks; fix code or update tests only when behavior intentionally changes.

## Work Guidance

- Put extension-specific unit tests in `extensions/<name>/test/` unless the coverage is shared harness behavior.
- Update stubs only when the Pi API shape used by tests changes.
- Keep integration tests focused on real runtime behavior that stubs cannot prove.

## Verification

- Run `pnpm test:extensions` for unit/smoke changes.
- Run `pnpm test:integration` for integration harness changes.
- Run `pnpm lint:typecheck` when test types, imports, or config-sensitive paths change.

## Child DOX Index

| Path | Owner Doc | Scope |
|------|-----------|-------|
| `fixtures/` | this file | Shared mock Pi/context builders. |
| `integration/` | this file + `docs/testing/integration-test.md` | Real Pi runtime integration tests. |
| `stubs/` | this file | Stubbed Pi packages for unit tests. |
| `types/` | this file | Test-only type declarations. |
