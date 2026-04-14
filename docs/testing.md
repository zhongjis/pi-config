# Panda Harness Testing

## Standard extension flow

Panda Harness keeps one repo-level test entrypoint for extensions:

- `pnpm test:extensions` — run repo-level Vitest coverage for extension entrypoints and existing extension tests
- `pnpm lint:typecheck` — run repo-level typechecking plus package-local lint/typecheck where those scripts already exist

## What counts as covered

Every existing extension should participate in the standard flow in one of these ways:

1. dedicated tests already present in the extension
2. repo-level smoke coverage through `test/extensions.smoke.test.ts`

## What the smoke harness checks

The root smoke harness is intentionally shallow and broad.

For every top-level extension entrypoint under `extensions/`, it:

1. discovers the entrypoint automatically
2. imports the module
3. verifies the default export is callable
4. runs the extension against a shared mock Pi runtime
5. fires common lifecycle hooks (`session_start`, `session_switch`, `session_tree`, `session_shutdown`)
6. asserts that the extension registered at least one command, tool, provider, renderer, shortcut, widget, flag, or lifecycle hook

The smoke harness is not a replacement for focused tests. It exists to catch extension-load regressions and missing runtime wiring in one consistent root flow.

## Maintenance notes

When adding a new extension:

1. add or keep dedicated tests when the extension has non-trivial logic
2. keep the extension compatible with the root smoke harness
3. keep the extension compatible with `pnpm test:extensions`
4. avoid behavior changes when only standardizing test coverage

## When to add dedicated tests

Add focused tests when an extension has:

- state transitions
- parsing or argument handling
- file or session persistence
- cross-extension coordination
- non-trivial lifecycle behavior

Smoke coverage should stay cheap. Focused behavior belongs in extension-local tests.
