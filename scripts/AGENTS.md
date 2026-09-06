## Purpose

Repository maintenance, validation, and runtime package-command helpers.

## Ownership

- This document owns every script in this directory.
- [../package.json](../package.json) owns root command entrypoints.
- [lint-typecheck.mjs](lint-typecheck.mjs) coordinates root and package checks.
- [pi-package-npm.sh](pi-package-npm.sh) selects ephemeral build tools and package managers.
- Prompt export/sync scripts maintain the [reference archive](../docs/references/oh-my-openagent/README.md).

## Local Contracts

- You MUST preserve command arguments and exit failures across wrappers.
- You MUST keep archive refreshes within the documented generated target.
- Archive `check` compares without replacing; `sync` replaces generated content.
- Default archive regeneration fetches pinned upstream dependencies; it is not an offline check.

## Work Guidance

- You SHOULD use fixture-driven tests for wrapper and archive changes.
- You MUST preserve the archive's documented provenance and licensing.

## Verification

- Package wrapper: `pnpm exec vitest run --project unit test/pi-package-npm.test.ts`.
- Archive helpers: `pnpm exec vitest run --project unit test/oh-my-openagent-final-prompts.test.ts`.
- Aggregate checks: `pnpm lint:typecheck`.
- Archive comparison: `pnpm check:oh-my-openagent-prompts` (fetches upstream).

## Child DOX Index

- None; this document owns all scripts and remaining files here.
